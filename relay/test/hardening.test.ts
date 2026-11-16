import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { b64urlDecode, importEd25519Public, parseJws, signJws, verifyJws } from "../src/crypto";
import type { Env } from "../src/env";
import { moveRobotsToZone } from "../src/claim";
import { FakeProvisioner } from "../src/provisioner";
import { watchAgentImage } from "../src/updates";
import { nowSeconds, randomToken } from "../src/util";
import { assertion, call, newRobot, newUser, ORIGIN, post, register, registerAndClaim, testEnv, type TestRobot } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

interface SelfBody {
  robotId: string;
  status: string;
  hostname: string | null;
  relayKeys: { kid: string; publicKey: string }[];
  members: { userId: string; role: string }[];
  updatesPaused?: boolean;
  signatures: string[];
}

/** GET /v1/robots/self with a known jti, at `origin` (the relay's or a legacy one). */
async function selfAt(robot: TestRobot, e: Env, origin = ORIGIN): Promise<{ res: Response; jti: string }> {
  const jti = randomToken(16);
  const iat = nowSeconds();
  const jws = await signJws(
    { alg: "EdDSA", typ: "mc-robot+jwt" },
    { iss: robot.robotId, aud: origin, htm: "GET", htu: `${origin}/v1/robots/self`, iat, exp: iat + 60, jti },
    robot.privateKey,
  );
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${origin}/v1/robots/self`, { headers: { Authorization: `MC-Robot ${jws}` } }) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return { res, jti };
}

async function fetchAt(url: string, e: Env, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(url, { redirect: "manual", ...init }) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Verifies every signature of a self answer against the keys it lists; returns the claims. */
async function verifiedClaims(body: SelfBody): Promise<Record<string, any>[]> {
  const out = [];
  for (const sig of body.signatures) {
    const p = parseJws(sig);
    expect(p.header.typ).toBe("mc-self+jwt");
    const key = body.relayKeys.find((k) => k.kid === p.header.kid);
    expect(key).toBeDefined();
    expect(await verifyJws(p, await importEd25519Public(b64urlDecode(key!.publicKey)))).toBe(true);
    out.push(p.payload);
  }
  return out;
}

async function newSigningKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d });
}

describe("signed answers to robots", () => {
  it("are signed by the relay key, bound to the robot and to its request", async () => {
    const user = await newUser();
    const { robot } = await registerAndClaim(user);
    const { res, jti } = await selfAt(robot, testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SelfBody;
    expect(body.signatures).toHaveLength(1);
    const [claims] = await verifiedClaims(body);
    expect(claims!.aud).toBe(`mc-robot:${robot.robotId}`);
    expect(claims!.req).toBe(jti);
    expect(claims!.relayOrigin).toBe(ORIGIN);
    const { signatures: _s, ...outer } = body;
    expect(claims!.self).toEqual(outer); // older agents read the same fields unsigned
    expect(claims!.self.members).toEqual([{ userId: user.id, role: "owner" }]);
  });

  it("are signed by the previous key too during a rotation, and list both keys", async () => {
    const e = { ...testEnv, RELAY_PREVIOUS_SIGNING_KEY: await newSigningKey(), RELAY_PREVIOUS_KEY_ID: "test-k0" };
    const robot = await newRobot();
    expect((await register(robot)).status).toBe(200);
    const body = (await (await selfAt(robot, e)).res.json()) as SelfBody;
    expect(body.relayKeys.map((k) => k.kid)).toEqual(["test-k1", "test-k0"]);
    expect(body.signatures).toHaveLength(2);
    const claims = await verifiedClaims(body);
    expect(claims.map((c) => parseJws(body.signatures[claims.indexOf(c)]!).header.kid)).toEqual(["test-k1", "test-k0"]);
  });
});

describe("domain move", () => {
  const NEW = "https://connect.new.test";
  const moved = (): Env => ({ ...testEnv, RELAY_ORIGIN: NEW, RELAY_LEGACY_ORIGINS: `${ORIGIN}, not-an-origin` });

  it("serves robots on a legacy origin and names the new one in the signed answer", async () => {
    const robot = await newRobot();
    expect((await register(robot)).status).toBe(200); // registered on the old origin
    const { res, jti } = await selfAt(robot, moved(), ORIGIN);
    expect(res.status).toBe(200);
    const [claims] = await verifiedClaims((await res.json()) as SelfBody);
    expect(claims!.relayOrigin).toBe(NEW);
    expect(claims!.req).toBe(jti);
    // And on the new origin with the same keys.
    const again = await selfAt(robot, moved(), NEW);
    expect(again.res.status).toBe(200);
  });

  it("refuses an assertion made for another origin than the one called", async () => {
    const robot = await newRobot();
    expect((await register(robot)).status).toBe(200);
    const jws = await assertion(robot, "GET", "/v1/robots/self"); // aud and htu: the old origin
    const res = await fetchAt(`${NEW}/v1/robots/self`, moved(), { headers: { Authorization: jws } });
    expect(res.status).toBe(401);
  });

  it("sends browsers to the new origin and serves nothing else on the old one", async () => {
    const res = await fetchAt(`${ORIGIN}/robots?x=1`, moved());
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${NEW}/robots?x=1`);
    const form = await fetchAt(`${ORIGIN}/claim`, moved(), { method: "POST", body: "code=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(421);
    expect((await fetchAt("https://elsewhere.test/", moved())).status).toBe(421);
    expect((await fetchAt(`${ORIGIN}/`, testEnv)).status).toBe(200); // without a move, the old origin is the origin
  });

  it("moves claimed robots' hostnames to a new robot zone, keeping their names", async () => {
    const user = await newUser();
    const { robot } = await registerAndClaim(user, "Back yard");
    const before = (await (await selfAt(robot, testEnv)).res.json()) as SelfBody;
    expect(before.hostname).toBe("back-yard.robots.test");
    const e = { ...testEnv, ROBOT_ZONE: "robots.new.test" };
    const prov = new FakeProvisioner("robots.new.test");
    let total = 0;
    for (let i = 0; i < 20 && (await moveRobotsToZone(e, prov)) > 0; i++) total++;
    expect(total).toBeGreaterThan(0);
    const after = (await (await selfAt(robot, e)).res.json()) as SelfBody;
    expect(after.hostname).toBe("back-yard.robots.new.test");
    expect(await moveRobotsToZone(e, prov)).toBe(0); // nothing left under the old zone
  });
});

describe("update pause", () => {
  it("is set and cleared on the admin page and reaches robots in their signed answer", async () => {
    const admin = await newUser("pauser");
    const e = { ...testEnv, ADMIN_GITHUB_IDS: admin.id };
    const robot = await newRobot();
    expect((await register(robot)).status).toBe(200);
    const paused = async () => {
      const body = (await (await selfAt(robot, e)).res.json()) as SelfBody;
      const [claims] = await verifiedClaims(body);
      return [body.updatesPaused ?? false, claims!.self.updatesPaused ?? false];
    };
    expect(await paused()).toEqual([false, false]);
    const postAs = (path: string, origin = ORIGIN) =>
      call(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: admin.cookie, Origin: origin }, body: "", redirect: "manual" }, e);
    expect((await postAs("/admin/updates/pause", "https://evil.test")).status).toBe(403); // CSRF
    expect(await paused()).toEqual([false, false]);
    expect((await postAs("/admin/updates/pause")).status).toBe(303);
    expect(await paused()).toEqual([true, true]);
    const page = await (await call("/admin", { headers: { Cookie: admin.cookie } }, e)).text();
    expect(page).toContain("Agent updates are paused");
    expect((await postAs("/admin/updates/resume")).status).toBe(303);
    expect(await paused()).toEqual([false, false]);
    // Not for anyone else.
    const other = await newUser();
    expect((await post("/admin/updates/pause", other, {})).status).toBe(404);
  });
});

describe("security alerts", () => {
  function stubNtfy() {
    const sent: { body: string; priority: string | null; tags: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith("https://ntfy.example/")) {
        const h = new Headers(init?.headers);
        sent.push({ body: String(init?.body), priority: h.get("Priority"), tags: h.get("Tags") });
      }
      return new Response("ok");
    });
    return sent;
  }

  it("are sent with high priority for every event, but not as a flood", async () => {
    const sent = stubNtfy();
    const { securityAlert } = await import("../src/alerts");
    const e = { ...testEnv, ALERT_NTFY_URL: "https://ntfy.example/topic" };
    await securityAlert(e, "unit_a", "one");
    await securityAlert(e, "unit_a", "flood");
    await securityAlert(e, "unit_b", "two");
    expect(sent.map((s) => s.body)).toEqual(["one", "two"]);
    expect(sent[0]!.priority).toBe("high");
    expect(sent[0]!.tags).toBe("rotating_light");
    // A minute later the same kind is sent again.
    const clock = vi.spyOn(Date, "now").mockReturnValue((nowSeconds() + 61) * 1000);
    try {
      await securityAlert(e, "unit_a", "again");
    } finally {
      clock.mockRestore();
    }
    expect(sent.at(-1)!.body).toBe("again");
  });

  it("tell the operator when a robot is paired and when updates are paused", async () => {
    const sent = stubNtfy();
    const admin = await newUser("alerted");
    const e = { ...testEnv, ALERT_NTFY_URL: "https://ntfy.example/topic", ADMIN_GITHUB_IDS: admin.id };
    const robot = await newRobot();
    const { pairingCode } = (await (await call("/v1/robots/register", {
      method: "POST",
      headers: { Authorization: await assertion(robot, "POST", "/v1/robots/register"), "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: robot.publicKey }),
    }, e)).json()) as { pairingCode: string };
    const claim = await call("/claim", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: admin.cookie, Origin: ORIGIN }, body: `code=${pairingCode}`, redirect: "manual" }, e);
    expect(claim.status).toBe(303);
    expect(sent.some((s) => s.body.startsWith("A robot was paired to the admin account"))).toBe(true);
    await call("/admin/updates/pause", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: admin.cookie, Origin: ORIGIN }, body: "", redirect: "manual" }, e);
    expect(sent.some((s) => s.body.startsWith("Agent updates are PAUSED"))).toBe(true);
    await call("/admin/updates/resume", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: admin.cookie, Origin: ORIGIN }, body: "", redirect: "manual" }, e);
  });
});

describe("release watch", () => {
  it("records the first digest of :latest and alerts on every change", async () => {
    await testEnv.DB.prepare("DELETE FROM settings WHERE key = 'agent_image_latest'").run();
    const sent = [] as string[];
    vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response("ok");
    });
    let digest = `sha256:${"a".repeat(64)}`;
    const seen: string[] = [];
    const ghcr = (async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      seen.push(url);
      if (url.startsWith("https://ghcr.io/token?")) return Response.json({ token: "anon" });
      expect(init?.method).toBe("HEAD");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer anon");
      return new Response(null, { status: 200, headers: { "Docker-Content-Digest": digest } });
    }) as typeof fetch;
    const e = { ...testEnv, ALERT_NTFY_URL: "https://ntfy.example/topic" };
    await watchAgentImage(e, "LilTaket/mowgli-connect", ghcr);
    expect(seen[1]).toBe("https://ghcr.io/v2/liltaket/mowgli-connect-agent/manifests/latest");
    expect(sent).toHaveLength(0); // first sighting: recorded only
    await watchAgentImage(e, "liltaket/mowgli-connect", ghcr);
    expect(sent).toHaveLength(0); // unchanged
    digest = `sha256:${"b".repeat(64)}`;
    await watchAgentImage(e, "liltaket/mowgli-connect", ghcr);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("New agent release");
    expect(sent[0]).toContain("sha256:bbbbbbbbbbbb");
  });

  it("ignores a registry answer that is not a digest", async () => {
    await testEnv.DB.prepare("DELETE FROM settings WHERE key = 'agent_image_latest'").run();
    const ghcr = (async (input: string | Request) =>
      String(typeof input === "string" ? input : input.url).includes("/token?")
        ? Response.json({ token: "anon" })
        : new Response(null, { status: 200, headers: { "Docker-Content-Digest": "nope" } })) as typeof fetch;
    await watchAgentImage(testEnv, "liltaket/mowgli-connect", ghcr);
    expect(await testEnv.DB.prepare("SELECT 1 FROM settings WHERE key = 'agent_image_latest'").first()).toBeNull();
  });
});
