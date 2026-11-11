import { describe, expect, it } from "vitest";
import { b64urlEncode } from "../src/crypto";
import type { Env } from "../src/env";
import { call, decodeJws, newRobot, newUser, ORIGIN, register, testEnv, type TestUser } from "./helpers";
import { nowSeconds, randomToken } from "../src/util";

const APP_ID = "ABCDE12345.garden.mowgli.app";
const env: Env = { ...testEnv, APP_IOS_APP_IDS: APP_ID };
const CALLBACK = `${ORIGIN}/app/callback`;
const enc = new TextEncoder();

interface Device {
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  key: CryptoKey;
  thumbprint: string;
}

async function newDevice(): Promise<Device> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const j = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwk = { kty: "EC" as const, crv: "P-256" as const, x: j.x!, y: j.y! };
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`)));
  return { jwk, key: pair.privateKey, thumbprint: b64urlEncode(d) };
}

async function sign(dev: Device, method: string, path: string, over: Record<string, unknown> = {}, iss = dev.thumbprint): Promise<string> {
  const now = nowSeconds();
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", typ: "mc-device+jwt" })));
  const p = b64urlEncode(enc.encode(JSON.stringify({ iss, aud: ORIGIN, htm: method, htu: `${ORIGIN}${path}`, iat: now, exp: now + 60, jti: randomToken(16), ...over })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, dev.key, enc.encode(`${h}.${p}`)));
  return `MC-Device ${h}.${p}.${b64urlEncode(sig)}`;
}

async function pkce() {
  const verifier = randomToken(32);
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  return { verifier, challenge };
}

function authorizeQuery(p: { challenge: string; thumbprint: string; state?: string; redirect?: string; name?: string }): URLSearchParams {
  return new URLSearchParams({
    redirect_uri: p.redirect ?? CALLBACK,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state ?? "state-" + randomToken(8),
    key_thumbprint: p.thumbprint,
    device_name: p.name ?? "Test iPhone",
  });
}

function postForm(path: string, user: TestUser, form: URLSearchParams, origin = ORIGIN, e: Env = env) {
  return call(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, Cookie: user.cookie }, body: form.toString(), redirect: "manual" }, e);
}

/** Runs the browser part and returns the one-time code. */
async function authorize(user: TestUser, dev: Device, ch: { challenge: string }, e: Env = env): Promise<string> {
  const q = authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint });
  const page = await call(`/app/authorize?${q}`, { headers: { Cookie: user.cookie }, redirect: "manual" }, e);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Test iPhone");
  q.set("decision", "allow");
  const res = await postForm("/app/authorize", user, q, ORIGIN, e);
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get("Location")!);
  expect(loc.origin + loc.pathname).toBe(CALLBACK);
  expect(loc.searchParams.get("state")).toBe(q.get("state"));
  return loc.searchParams.get("code")!;
}

async function exchange(dev: Device, code: string, verifier: string, e: Env = env, keyFor: Device = dev) {
  return call(
    "/v1/app/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: await sign(keyFor, "POST", "/v1/app/token") },
      body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: CALLBACK, device_key: dev.jwk }),
    },
    e,
  );
}

async function signedIn(user?: TestUser, e: Env = env) {
  const u = user ?? (await newUser());
  const dev = await newDevice();
  const ch = await pkce();
  const code = await authorize(u, dev, ch, e);
  const res = await exchange(dev, code, ch.verifier, e);
  expect(res.status).toBe(200);
  return { user: u, dev };
}

async function api(dev: Device, method: string, path: string, body?: unknown, e: Env = env) {
  return call(
    path,
    {
      method,
      headers: { Authorization: await sign(dev, method, path), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
    e,
  );
}

describe("app API off by default", () => {
  it("answers 404 everywhere without APP_IOS_APP_IDS", async () => {
    const user = await newUser();
    expect((await call("/.well-known/apple-app-site-association", {}, testEnv)).status).toBe(404);
    expect((await call("/v1/app/me", {}, testEnv)).status).toBe(404);
    expect((await call("/app/authorize?x=1", { headers: { Cookie: user.cookie } }, testEnv)).status).toBe(404);
    expect(await (await call("/", { headers: { Cookie: user.cookie } }, testEnv)).text()).not.toContain("Devices");
  });

  it("serves apple-app-site-association for the configured app only, for the callback path only", async () => {
    const res = await call("/.well-known/apple-app-site-association", {}, { ...env, APP_IOS_APP_IDS: `${APP_ID}, not-an-id, ../x` });
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const j = (await res.json()) as { applinks: { details: { appIDs: string[]; components: { "/": string }[] }[] }; webcredentials: { apps: string[] } };
    expect(j.webcredentials.apps).toEqual([APP_ID]);
    expect(j.applinks.details[0]!.appIDs).toEqual([APP_ID]);
    expect(j.applinks.details[0]!.components.map((c) => c["/"])).toEqual(["/app/callback"]);
  });
});

describe("app sign-in", () => {
  it("full flow: consent, code, device, robots, grant, claim and sign-out", async () => {
    const { user, dev } = await signedIn();
    const me = await api(dev, "GET", "/v1/app/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { login: string }).login).toMatch(/^user/);

    // Pair a robot from the app.
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "App Bot")).json()) as { pairingCode: string };
    const prev = await api(dev, "POST", "/v1/app/claim", { code: pairingCode, step: "preview" });
    expect(await prev.json()).toMatchObject({ robotId: robot.robotId, hostname: "app-bot.robots.test" });
    const done = await api(dev, "POST", "/v1/app/claim", { code: pairingCode, step: "confirm" });
    expect(await done.json()).toMatchObject({ robotId: robot.robotId, hostname: "app-bot.robots.test" });

    const list = (await (await api(dev, "GET", "/v1/app/robots")).json()) as { robots: { robotId: string; role: string; hostname: string }[] };
    expect(list.robots).toEqual([expect.objectContaining({ robotId: robot.robotId, role: "owner", hostname: "app-bot.robots.test" })]);

    const g = (await (await api(dev, "POST", `/v1/app/robots/${robot.robotId}/grant`)).json()) as { grant: string; hostname: string };
    expect(g.hostname).toBe("app-bot.robots.test");
    const claims = decodeJws(g.grant).payload;
    expect(claims).toMatchObject({ aud: `mc-robot:${robot.robotId}`, sub: user.id, role: "owner" });

    // The device appears under Devices; signing out from the app removes it.
    expect(await (await call("/", { headers: { Cookie: user.cookie } }, env)).text()).toContain("Test iPhone");
    expect((await api(dev, "POST", "/v1/app/sign-out")).status).toBe(200);
    const after = await api(dev, "GET", "/v1/app/me");
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ detail: "unknown_device" });
  });

  it("not signed in: the sheet goes through GitHub sign-in and comes back to the consent page", async () => {
    const dev = await newDevice();
    const q = authorizeQuery({ challenge: (await pkce()).challenge, thumbprint: dev.thumbprint });
    const res = await call(`/app/authorize?${q}`, { redirect: "manual" }, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!, ORIGIN);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("return_to")).toBe(`/app/authorize?${q}`);
  });

  it("rejects bad parameters, other sites, and denial", async () => {
    const user = await newUser();
    const dev = await newDevice();
    const ch = await pkce();
    for (const q of [
      authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint, redirect: "https://evil.example/app/callback" }),
      authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint, redirect: `${ORIGIN}/app/callback/../x` }),
      authorizeQuery({ challenge: "short", thumbprint: dev.thumbprint }),
      authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint, state: "short" }),
      authorizeQuery({ challenge: ch.challenge, thumbprint: "x" }),
      (() => {
        const q = authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint });
        q.set("code_challenge_method", "plain");
        return q;
      })(),
    ]) {
      const res = await call(`/app/authorize?${q}`, { headers: { Cookie: user.cookie }, redirect: "manual" }, env);
      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull(); // never redirects anywhere with bad input
    }
    const q = authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint });
    q.set("decision", "allow");
    expect((await postForm("/app/authorize", user, q, "https://evil.example")).status).toBe(403);
    q.set("decision", "deny");
    const denied = await postForm("/app/authorize", user, q);
    expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM app_codes WHERE user_id = ?").bind(user.id).first()).toEqual({ n: 0 });
  });

  it("a code works once, only with its verifier, only with its key, only for 60 seconds", async () => {
    const user = await newUser();
    const dev = await newDevice();
    const other = await newDevice();
    const ch = await pkce();

    let code = await authorize(user, dev, ch);
    // Wrong verifier, another key, or a signature by another key: refused, and the code survives
    // for the rightful exchange (someone who saw it cannot spoil the sign-in).
    expect((await exchange(dev, code, (await pkce()).verifier)).status).toBe(400);
    expect((await exchange(other, code, ch.verifier)).status).toBe(400);
    expect((await exchange(dev, code, ch.verifier, env, other)).status).toBe(401);
    expect((await exchange(dev, code, ch.verifier)).status).toBe(200);
    expect((await exchange(dev, code, ch.verifier)).status).toBe(400); // used

    code = await authorize(user, dev, ch);
    await testEnv.DB.prepare("UPDATE app_codes SET expires_at = ? WHERE user_id = ?").bind(nowSeconds() - 1, user.id).run();
    expect((await exchange(dev, code, ch.verifier)).status).toBe(400);

  });

  it("writes nothing for made-up codes (review 11)", async () => {
    const count = async () => (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM jti_seen WHERE robot_id LIKE 'dev:%'").first<{ n: number }>())!.n;
    const before = await count();
    const dev = await newDevice();
    for (let i = 0; i < 10; i++) expect((await exchange(dev, randomToken(32), randomToken(32))).status).toBe(400);
    expect(await count()).toBe(before);
  });

  it("holds the device limit and key ownership under concurrency (review 11)", async () => {
    const user = await newUser();
    for (let i = 0; i < 9; i++) await signedIn(user);
    const devs = await Promise.all(Array.from({ length: 5 }, () => newDevice()));
    const ready = await Promise.all(
      devs.map(async (d) => {
        const ch = await pkce();
        return { d, ch, code: await authorize(user, d, ch) };
      }),
    );
    const codes = (await Promise.all(ready.map((r) => exchange(r.d, r.code, r.ch.verifier)))).map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ?").bind(user.id).first()).toEqual({ n: 10 });

    const shared = await newDevice();
    const [a, b] = [await newUser(), await newUser()];
    const ca = await pkce();
    const cb = await pkce();
    const [codeA, codeB] = [await authorize(a, shared, ca), await authorize(b, shared, cb)];
    const both = (await Promise.all([exchange(shared, codeA, ca.verifier), exchange(shared, codeB, cb.verifier)])).map((r) => r.status).sort();
    expect(both).toEqual([200, 409]);
  });

  it("limits open codes and devices per person", async () => {
    const user = await newUser();
    const dev = await newDevice();
    const ch = await pkce();
    for (let i = 0; i < 5; i++) await authorize(user, dev, ch);
    const q = authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint });
    q.set("decision", "allow");
    const sixth = await postForm("/app/authorize", user, q);
    expect(new URL(sixth.headers.get("Location")!).searchParams.get("error")).toBe("slow_down");

    const many = await newUser();
    for (let i = 0; i < 10; i++) await signedIn(many);
    const extra = await newDevice();
    const page = await call(`/app/authorize?${authorizeQuery({ challenge: ch.challenge, thumbprint: extra.thumbprint })}`, { headers: { Cookie: many.cookie } }, env);
    expect(page.status).toBe(403);
  });

  it("a device key belongs to one person", async () => {
    const { dev } = await signedIn();
    const someoneElse = await newUser();
    const ch = await pkce();
    const code = await authorize(someoneElse, dev, ch);
    expect((await exchange(dev, code, ch.verifier)).status).toBe(409);
  });
});

describe("signed app calls", () => {
  it("refuse replays, other methods or paths, other audiences, long lifetimes and unknown devices", async () => {
    const { dev } = await signedIn();
    const auth = await sign(dev, "GET", "/v1/app/me");
    expect((await call("/v1/app/me", { headers: { Authorization: auth } }, env)).status).toBe(200);
    const replay = await call("/v1/app/me", { headers: { Authorization: auth } }, env);
    expect(await replay.json()).toMatchObject({ detail: "replayed_jti" });
    const cases: [Record<string, unknown>, string, string, string][] = [
      [{}, "POST", "/v1/app/me", "bad_htm"],
      [{ htu: `${ORIGIN}/v1/app/robots` }, "GET", "/v1/app/me", "bad_htu"],
      [{ aud: "https://evil.example" }, "GET", "/v1/app/me", "bad_aud"],
      [{ exp: nowSeconds() + 3600 }, "GET", "/v1/app/me", "bad_lifetime"],
      [{ jti: "short" }, "GET", "/v1/app/me", "bad_jti"],
    ];
    for (const [over, signedMethod, path, detail] of cases) {
      const a = await sign(dev, signedMethod, path, over);
      const r = await call("/v1/app/me", { headers: { Authorization: a } }, env);
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ detail });
    }
    const stranger = await newDevice();
    expect(await (await call("/v1/app/me", { headers: { Authorization: await sign(stranger, "GET", "/v1/app/me") } }, env)).json()).toMatchObject({
      detail: "unknown_device",
    });
    // Signed with another key but claiming this device's id.
    const forged = await sign(stranger, "GET", "/v1/app/me", {}, dev.thumbprint);
    expect(await (await call("/v1/app/me", { headers: { Authorization: forged } }, env)).json()).toMatchObject({ detail: "bad_signature" });
  });

  it("give no grant for robots of others, and stop when access is removed", async () => {
    const admin = await newUser("app-admin");
    const e: Env = { ...env, ALLOWED_GITHUB_LOGINS: "", ADMIN_GITHUB_IDS: admin.id };
    const invited = await newUser();
    await testEnv.DB.prepare("INSERT INTO invites (user_id, login, name, robot_limit, invited_by, created_at) VALUES (?, 'x', NULL, NULL, ?, 0)").bind(invited.id, admin.id).run();
    const { dev } = await signedIn(invited, e);
    const robot = await newRobot();
    await register(robot, "not-yours");
    expect((await api(dev, "POST", `/v1/app/robots/${robot.robotId}/grant`, undefined, e)).status).toBe(404);

    // Removing the person from the admin page deletes their devices.
    const rm = await call(`/admin/people/${invited.id}/remove`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: admin.cookie }, body: "", redirect: "manual" }, e);
    expect(rm.status).toBe(303);
    expect((await api(dev, "GET", "/v1/app/me", undefined, e)).status).toBe(401);
  });

  it("stop at once when the person is no longer allowed, even before the device is deleted", async () => {
    const { dev } = await signedIn();
    const res = await api(dev, "GET", "/v1/app/me", undefined, { ...env, ALLOWED_GITHUB_LOGINS: "" });
    expect(res.status).toBe(403);
  });

  it("devices can be signed out from the robots page, by their owner only", async () => {
    const { user, dev } = await signedIn();
    const other = await newUser();
    const revoke = (u: TestUser, origin = ORIGIN) =>
      call(`/devices/${dev.thumbprint}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, Cookie: u.cookie }, body: "", redirect: "manual" }, env);
    expect((await revoke(other)).status).toBe(404);
    expect((await revoke(user, "https://evil.example")).status).toBe(403);
    // Signing a device out also signs everyone out of the robots its owner owns (its open
    // robot sessions end too), and not of anyone else's robots.
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "revoke-me")).json()) as { pairingCode: string };
    await api(dev, "POST", "/v1/app/claim", { code: pairingCode, step: "confirm" });
    const epoch = async (id: string) => (await testEnv.DB.prepare("SELECT session_epoch AS e FROM robots WHERE robot_id = ?").bind(id).first<{ e: number }>())!.e;
    const before = await epoch(robot.robotId);
    expect((await revoke(user)).status).toBe(303);
    expect((await api(dev, "GET", "/v1/app/me")).status).toBe(401);
    expect(await epoch(robot.robotId)).toBe(before + 1);
  });
});

describe("review 11 (Opus) fixes", () => {
  it("drops invisible and text-direction characters from device names", async () => {
    const user = await newUser();
    const dev = await newDevice();
    const q = authorizeQuery({ challenge: (await pkce()).challenge, thumbprint: dev.thumbprint, name: "Bruno‮s iPh​one⁦x" });
    const body = await (await call(`/app/authorize?${q}`, { headers: { Cookie: user.cookie } }, env)).text();
    expect(body).toContain("Brunos iPhonex");
    expect(body).not.toMatch(/[​‮⁦]/);
  });

  it("sends a real Origin from the consent page and keeps the callback page's address to itself", async () => {
    const user = await newUser();
    const dev = await newDevice();
    const q = authorizeQuery({ challenge: (await pkce()).challenge, thumbprint: dev.thumbprint });
    const consent = await call(`/app/authorize?${q}`, { headers: { Cookie: user.cookie } }, env);
    expect(consent.headers.get("Referrer-Policy")).toBe("same-origin");
    const cb = await call("/app/callback?code=x&state=y", {}, env);
    expect(cb.headers.get("Referrer-Policy")).toBe("no-referrer");
    const text = await cb.text();
    expect(text).toContain("Never copy or send the address of this page");
    expect(text).not.toContain("code=x");
  });

  it("signs out devices unused for 180 days", async () => {
    const { dev } = await signedIn();
    await testEnv.DB.prepare("UPDATE devices SET last_used_at = last_used_at - 181 * 86400 WHERE device_id = ?").bind(dev.thumbprint).run();
    expect(await (await api(dev, "GET", "/v1/app/me")).json()).toMatchObject({ detail: "unknown_device" });
  });
});

describe("private-use scheme callback (free Apple team)", () => {
  const SCHEME_URI = "garden.mowgli.app:/connect/callback";
  const e2: Env = { ...env, APP_REDIRECT_URIS: `${SCHEME_URI}, com.evil.app:/connect/callback, garden.mowgli.app:/../x, Garden.Mowgli.App:/connect/callback` };

  it("accepts exactly the configured scheme of the configured app, binds it to the code, and allows it in form-action", async () => {
    const user = await newUser();
    const dev = await newDevice();
    const ch = await pkce();
    const q = authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint, redirect: SCHEME_URI });
    const page = await call(`/app/authorize?${q}`, { headers: { Cookie: user.cookie } }, e2);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("form-action 'self' garden.mowgli.app:");
    q.set("decision", "allow");
    const res = await postForm("/app/authorize", user, q, ORIGIN, e2);
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith(`${SCHEME_URI}?`)).toBe(true);
    const code = new URL(loc).searchParams.get("code")!;

    const tokenWith = async (redirect: string) =>
      call("/v1/app/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: await sign(dev, "POST", "/v1/app/token") },
        body: JSON.stringify({ code, code_verifier: ch.verifier, redirect_uri: redirect, device_key: dev.jwk }),
      }, e2);
    expect((await tokenWith(CALLBACK)).status).toBe(400); // issued for the scheme, not the https callback
    expect((await tokenWith(SCHEME_URI)).status).toBe(200);
  });

  it("ignores schemes that are not the configured app's, and malformed ones", async () => {
    const user = await newUser();
    const dev = await newDevice();
    const ch = await pkce();
    for (const redirect of ["com.evil.app:/connect/callback", "garden.mowgli.app:/../x", "Garden.Mowgli.App:/connect/callback", "garden.mowgli.app:/connect/other", "garden.mowgli.app://connect/callback"]) {
      const q = authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint, redirect });
      expect((await call(`/app/authorize?${q}`, { headers: { Cookie: user.cookie }, redirect: "manual" }, e2)).status).toBe(400);
    }
    // Without APP_REDIRECT_URIS the scheme is not accepted at all.
    const q = authorizeQuery({ challenge: ch.challenge, thumbprint: dev.thumbprint, redirect: SCHEME_URI });
    expect((await call(`/app/authorize?${q}`, { headers: { Cookie: user.cookie }, redirect: "manual" }, env)).status).toBe(400);
  });
});

describe("app sign-out ends robot sessions (coordinator task)", () => {
  const epoch = async (id: string) => (await testEnv.DB.prepare("SELECT session_epoch AS e FROM robots WHERE robot_id = ?").bind(id).first<{ e: number }>())!.e;
  async function ownedRobot(dev: Device, name: string) {
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, name)).json()) as { pairingCode: string };
    expect((await api(dev, "POST", "/v1/app/claim", { code: pairingCode, step: "confirm" })).status).toBe(200);
    return robot;
  }

  it("bumps the epoch of the owner's robots only, and a grant from before is stale afterwards", async () => {
    const { user, dev } = await signedIn();
    const mine = await ownedRobot(dev, "signout-mine");

    // Someone else's robot, on which this person is only a viewer.
    const other = await signedIn();
    const theirs = await ownedRobot(other.dev, "signout-theirs");
    await testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, label, created_at) VALUES (?, ?, 'viewer', NULL, 0)").bind(theirs.robotId, user.id).run();
    const unrelated = await ownedRobot((await signedIn()).dev, "signout-unrelated");

    const grantBefore = (await (await api(dev, "POST", `/v1/app/robots/${mine.robotId}/grant`)).json()) as { grant: string };
    const before = { mine: await epoch(mine.robotId), theirs: await epoch(theirs.robotId), unrelated: await epoch(unrelated.robotId) };
    expect(decodeJws(grantBefore.grant).payload.epoch).toBe(before.mine);

    expect((await api(dev, "POST", "/v1/app/sign-out")).status).toBe(200);
    expect(await epoch(mine.robotId)).toBe(before.mine + 1);
    expect(await epoch(theirs.robotId)).toBe(before.theirs); // viewer-only: untouched
    expect(await epoch(unrelated.robotId)).toBe(before.unrelated);

    // The robot learns the new epoch at its next sync, and then refuses sessions and grants
    // from before (agent: TestEpochBumpEndsEarlierSessionsAndGrants).
    const self = (await (await call("/v1/robots/self", { headers: { Authorization: await robotAssertion(mine) } }, env)).json()) as { sessionEpoch: number };
    expect(self.sessionEpoch).toBe(before.mine + 1);
    expect(decodeJws(grantBefore.grant).payload.epoch).toBeLessThan(self.sessionEpoch);

    // Signing out again is a clean 401 and bumps nothing.
    const again = await api(dev, "POST", "/v1/app/sign-out");
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ detail: "unknown_device" });
    expect(await epoch(mine.robotId)).toBe(before.mine + 1);
  });

  it("concurrent sign-outs of one device bump the epoch once", async () => {
    const { dev } = await signedIn();
    const mine = await ownedRobot(dev, "signout-race");
    const before = await epoch(mine.robotId);
    const codes = (await Promise.all([api(dev, "POST", "/v1/app/sign-out"), api(dev, "POST", "/v1/app/sign-out"), api(dev, "POST", "/v1/app/sign-out")])).map((r) => r.status);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    expect(codes.every((c) => c === 200 || c === 401)).toBe(true);
    expect(await epoch(mine.robotId)).toBe(before + 1);
  });

  it("a failed revocation (someone else's device) bumps nothing", async () => {
    const { dev } = await signedIn();
    const mine = await ownedRobot(dev, "signout-foreign");
    const before = await epoch(mine.robotId);
    const stranger = await newUser();
    const res = await call(`/devices/${dev.thumbprint}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: stranger.cookie }, body: "", redirect: "manual" }, env);
    expect(res.status).toBe(404);
    expect(await epoch(mine.robotId)).toBe(before);
    expect((await api(dev, "GET", "/v1/app/me")).status).toBe(200);
  });
});

async function robotAssertion(robot: Awaited<ReturnType<typeof newRobot>>): Promise<string> {
  const { assertion } = await import("./helpers");
  return assertion(robot, "GET", "/v1/robots/self");
}

describe("sign-out races (review 13)", () => {
  const epoch = async (id: string) => (await testEnv.DB.prepare("SELECT session_epoch AS e FROM robots WHERE robot_id = ?").bind(id).first<{ e: number }>())!.e;

  it("a grant whose epoch is read after a sign-out commits is refused, never minted at the new epoch", async () => {
    const { user, dev } = await signedIn();
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "race-grant")).json()) as { pairingCode: string };
    await api(dev, "POST", "/v1/app/claim", { code: pairingCode, step: "confirm" });
    const before = await epoch(robot.robotId);
    const { signOutDevice } = await import("../src/appApi");
    // Run the sign-out right before the grant reads the epoch.
    let fired = false;
    const db = testEnv.DB;
    const wrapped = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const st = target.prepare(sql);
            if (fired || !sql.includes("EXISTS (SELECT 1 FROM devices WHERE device_id = ?3")) return st;
            fired = true;
            return {
              bind: (...args: unknown[]) => ({
                first: async () => {
                  await signOutDevice(testEnv, dev.thumbprint, user.id);
                  return st.bind(...args).first();
                },
              }),
            };
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await api(dev, "POST", `/v1/app/robots/${robot.robotId}/grant`, undefined, { ...env, DB: wrapped as unknown as D1Database });
    expect(fired).toBe(true);
    expect(res.status).toBe(404);
    expect(await epoch(robot.robotId)).toBe(before + 1);
  });

  it("a sign-in the same key started before the sign-out cannot bring the device back", async () => {
    const { user, dev } = await signedIn();
    const ch = await pkce();
    const code = await authorize(user, dev, ch); // pending when the sign-out happens
    expect((await api(dev, "POST", "/v1/app/sign-out")).status).toBe(200);
    expect((await exchange(dev, code, ch.verifier)).status).toBe(400);
    expect(await testEnv.DB.prepare("SELECT 1 AS ok FROM devices WHERE device_id = ?").bind(dev.thumbprint).first()).toBeNull();
  });

  it("revoking a device from the robots page ends pending app sign-ins and the person's other relay sessions", async () => {
    const { user, dev } = await signedIn();
    const { createSession } = await import("../src/session");
    const phoneBrowser = `__Host-mcr_session=${await createSession(testEnv, user.id)}`; // the lost phone's Safari
    const otherKey = await newDevice();
    const ch = await pkce();
    const code = await authorize(user, otherKey, ch); // the phone started a fresh sign-in with a new key
    const res = await call(`/devices/${dev.thumbprint}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: user.cookie }, body: "", redirect: "manual" }, env);
    expect(res.status).toBe(303);
    expect(await (await call("/", { headers: { Cookie: user.cookie } }, env)).text()).toContain("My robots"); // this browser stays
    expect(await (await call("/", { headers: { Cookie: phoneBrowser } }, env)).text()).toContain("Sign in with GitHub");
    expect((await exchange(otherKey, code, ch.verifier)).status).toBe(400);
  });
});

describe("app API under the emergency stop", () => {
  it("refuses everything but sign-out, and works again when it is lifted", async () => {
    const { dev } = await signedIn();
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "kill-bot")).json()) as { pairingCode: string };
    expect((await api(dev, "POST", "/v1/app/claim", { code: pairingCode, step: "confirm" })).status).toBe(200);
    expect((await api(dev, "POST", `/v1/app/robots/${robot.robotId}/grant`)).status).toBe(200);

    await testEnv.DB.prepare("INSERT INTO settings (key, value) VALUES ('kill_switch', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    try {
      for (const [method, path] of [["POST", `/v1/app/robots/${robot.robotId}/grant`], ["GET", "/v1/app/robots"], ["GET", "/v1/app/me"]] as const) {
        const res = await api(dev, method, path);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "paused" });
      }
    } finally {
      await testEnv.DB.prepare("DELETE FROM settings WHERE key = 'kill_switch'").run();
    }
    expect((await api(dev, "POST", `/v1/app/robots/${robot.robotId}/grant`)).status).toBe(200);
    expect((await api(dev, "POST", "/v1/app/sign-out")).status).toBe(200);
  });
});
