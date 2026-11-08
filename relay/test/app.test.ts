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
    expect((await exchange(dev, code, (await pkce()).verifier)).status).toBe(400); // wrong verifier burns the code
    expect((await exchange(dev, code, ch.verifier)).status).toBe(400);

    code = await authorize(user, dev, ch);
    expect((await exchange(other, code, ch.verifier)).status).toBe(400); // another key than the bound thumbprint

    code = await authorize(user, dev, ch);
    // Signed by another key than the one being registered: no proof of possession.
    const res = await exchange(dev, code, ch.verifier, env, other);
    expect(res.status).toBe(401);

    code = await authorize(user, dev, ch);
    await testEnv.DB.prepare("UPDATE app_codes SET expires_at = ? WHERE user_id = ?").bind(nowSeconds() - 1, user.id).run();
    expect((await exchange(dev, code, ch.verifier)).status).toBe(400);

    code = await authorize(user, dev, ch);
    expect((await exchange(dev, code, ch.verifier)).status).toBe(200);
    expect((await exchange(dev, code, ch.verifier)).status).toBe(400); // used
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
    expect((await revoke(user)).status).toBe(303);
    expect((await api(dev, "GET", "/v1/app/me")).status).toBe(401);
  });
});
