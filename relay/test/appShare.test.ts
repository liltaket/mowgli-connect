import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64urlEncode } from "../src/crypto";
import type { Env } from "../src/env";
import { call, decodeJws, newRobot, newUser, ORIGIN, register, testEnv, type TestUser } from "./helpers";
import { MAX_SHARES_PER_ROBOT } from "../src/share";
import { nowSeconds, randomToken } from "../src/util";

const APP_ID = "ABCDE12345.garden.mowgli.app";
// Owners are invited; everyone else is a guest or nobody.
const env: Env = { ...testEnv, APP_IOS_APP_IDS: APP_ID, ALLOWED_GITHUB_LOGINS: "" };
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


// Fake GitHub account lookups: /users/<login> and /user/<id>.
let accounts: { id: number; login: string; name?: string | null }[] = [];
beforeEach(() => {
  accounts = [];
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const url = typeof input === "string" ? input : input.url;
    const byLogin = /^https:\/\/api\.github\.com\/users\/([^/]+)$/.exec(url);
    const byId = /^https:\/\/api\.github\.com\/user\/(\d+)$/.exec(url);
    if (!byLogin && !byId) return new Response("unexpected", { status: 500 });
    const p = accounts.find((x) => (byLogin ? x.login.toLowerCase() === decodeURIComponent(byLogin[1]!).toLowerCase() : String(x.id) === byId![1]));
    if (!p) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return Response.json({ type: "User", name: null, created_at: "2016-02-01T00:00:00Z", ...p });
  });
});
afterEach(() => vi.unstubAllGlobals());

const numeric = (u: TestUser) => Number(u.id.slice(3));

async function ownerWithRobot() {
  const owner = await newUser("share-owner");
  await testEnv.DB.prepare("INSERT INTO invites (user_id, login, invited_by, created_at) VALUES (?, ?, 'gh:1', 0)").bind(owner.id, "share-owner").run();
  const robot = await newRobot();
  const { pairingCode } = (await (await register(robot, "Bot")).json()) as { pairingCode: string };
  const claim = await call("/claim", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: owner.cookie }, body: `code=${pairingCode}&label=Lawn`, redirect: "manual" }, env);
  expect(claim.status).toBe(303);
  const { dev } = await signedIn(owner, env);
  return { owner, robot, dev, base: `/v1/app/robots/${robot.robotId}` };
}

async function shareWith(dev: Device, base: string, guest: TestUser, login: string, role: string) {
  accounts.push({ id: numeric(guest), login });
  const found = await api(dev, "POST", `${base}/shares/lookup`, { login }, env);
  expect(found.status).toBe(200);
  const profile = (await found.json()) as { id: string };
  return api(dev, "POST", `${base}/shares`, { id: profile.id, role }, env);
}

describe("sharing from the app", () => {
  it("looks the account up, shares it, changes the role, lists it and removes it", async () => {
    const { dev, base } = await ownerWithRobot();
    const guest = await newUser("app-guest-1");
    accounts.push({ id: numeric(guest), login: "app-guest-1", name: "Gina Guest" });

    // Step 1 shows the account and writes nothing.
    const found = await api(dev, "POST", `${base}/shares/lookup`, { login: "App-Guest-1" }, env);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ id: String(numeric(guest)), login: "app-guest-1", name: "Gina Guest", joinedYear: 2016 });
    expect(await (await api(dev, "GET", `${base}/shares`, undefined, env)).json()).toEqual({ shares: [], limit: MAX_SHARES_PER_ROBOT });

    // Step 2 shares by id, with the role asked for.
    const added = await api(dev, "POST", `${base}/shares`, { id: String(numeric(guest)), role: "viewer" }, env);
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ ok: true, userId: guest.id });
    const list = (await (await api(dev, "GET", `${base}/shares`, undefined, env)).json()) as { shares: Record<string, unknown>[] };
    expect(list.shares).toMatchObject([{ userId: guest.id, login: "app-guest-1", role: "viewer", signedIn: true }]);

    // The guest opens it from their own app with that role, then with the changed one.
    const gdev = (await signedIn(guest, env)).dev;
    const grantRole = async () => decodeJws(((await (await api(gdev, "POST", `${base}/grant`, undefined, env)).json()) as { grant: string }).grant).payload.role;
    expect(await grantRole()).toBe("viewer");
    expect((await api(dev, "POST", `${base}/shares/${guest.id}/role`, { role: "operator" }, env)).status).toBe(200);
    expect(await grantRole()).toBe("operator");

    // Removing it signs the guest's app out (their last way in).
    expect((await api(dev, "POST", `${base}/shares/${guest.id}/remove`, undefined, env)).status).toBe(200);
    expect((await api(gdev, "GET", "/v1/app/robots", undefined, env)).status).toBe(401);
    expect(await (await api(dev, "GET", `${base}/shares`, undefined, env)).json()).toEqual({ shares: [], limit: MAX_SHARES_PER_ROBOT });
    expect((await api(dev, "POST", `${base}/shares/${guest.id}/remove`, undefined, env)).status).toBe(404);
  });

  it("answers 404 to everyone but the owner, the people it is shared with included", async () => {
    const { dev, base } = await ownerWithRobot();
    const guest = await newUser("app-guest-2");
    expect((await shareWith(dev, base, guest, "app-guest-2", "operator")).status).toBe(200);
    const gdev = (await signedIn(guest, env)).dev;
    const viewer = await newUser("app-viewer");
    expect((await shareWith(dev, base, viewer, "app-viewer", "viewer")).status).toBe(200);
    const vdev = (await signedIn(viewer, env)).dev;
    for (const d of [gdev, vdev]) {
      expect((await api(d, "GET", `${base}/shares`, undefined, env)).status).toBe(404);
      expect((await api(d, "POST", `${base}/shares/lookup`, { login: "x" }, env)).status).toBe(404);
      expect((await api(d, "POST", `${base}/shares`, { id: "123", role: "operator" }, env)).status).toBe(404);
      expect((await api(d, "POST", `${base}/shares/${guest.id}/role`, { role: "viewer" }, env)).status).toBe(404);
      expect((await api(d, "POST", `${base}/shares/${guest.id}/remove`, undefined, env)).status).toBe(404);
    }
    // Nothing changed: still an operator.
    const row = await testEnv.DB.prepare("SELECT role FROM members WHERE user_id = ?").bind(guest.id).first<{ role: string }>();
    expect(row?.role).toBe("operator");
    // The owner cannot "leave" their own robot.
    expect((await api(dev, "POST", `${base}/leave`, undefined, env)).status).toBe(404);
  });

  it("answers 404 to another owner, and to an owner the admin removed who is still a guest elsewhere, without spending lookups", async () => {
    const { dev, base, owner } = await ownerWithRobot();
    const victim = await newUser("app-victim");
    expect((await shareWith(dev, base, victim, "app-victim", "viewer")).status).toBe(200);
    const lookupsBy = async (id: string) =>
      (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM share_events WHERE user_id = ? AND kind = 'lookup'").bind(id).first<{ n: number }>())!.n;

    // Another invited owner, with a robot of their own, on this robot's routes.
    const rival = await newUser("app-rival");
    await testEnv.DB.prepare("INSERT INTO invites (user_id, login, invited_by, created_at) VALUES (?, ?, 'gh:1', 0)").bind(rival.id, "app-rival").run();
    const rdev = (await signedIn(rival, env)).dev;
    accounts.push({ id: 4242424, login: "wanted" });
    const check = async (d: Device, who: string) => {
      const before = await lookupsBy(who);
      expect((await api(d, "GET", `${base}/shares`, undefined, env)).status).toBe(404);
      expect((await api(d, "POST", `${base}/shares/lookup`, { login: "wanted" }, env)).status).toBe(404);
      expect((await api(d, "POST", `${base}/shares`, { id: "4242424", role: "viewer" }, env)).status).toBe(404);
      expect((await api(d, "POST", `${base}/shares/${victim.id}/role`, { role: "operator" }, env)).status).toBe(404);
      expect((await api(d, "POST", `${base}/shares/${victim.id}/remove`, undefined, env)).status).toBe(404);
      expect(await lookupsBy(who), who).toBe(before);
    };
    await check(rdev, rival.id);

    // The owner is removed by the admin, but someone's share keeps them able to sign in as a guest.
    const o2 = await ownerWithRobot();
    expect((await shareWith(o2.dev, o2.base, owner, "share-owner", "viewer")).status).toBe(200);
    await testEnv.DB.prepare("DELETE FROM invites WHERE user_id = ?").bind(owner.id).run();
    await check(dev, owner.id);
    const row = await testEnv.DB.prepare("SELECT role FROM members WHERE user_id = ?").bind(victim.id).first<{ role: string }>();
    expect(row?.role).toBe("viewer");
  });

  it("refuses bad input, your own account, repeats and an owner role", async () => {
    const { owner, dev, base } = await ownerWithRobot();
    const guest = await newUser("app-guest-3");
    accounts.push({ id: numeric(guest), login: "app-guest-3" }, { id: numeric(owner), login: "share-owner" });
    const id = String(numeric(guest));
    for (const [body, status, error] of [
      [{ id, role: "owner" }, 400, "bad_role"],
      [{ id, role: "admin" }, 400, "bad_role"],
      [{ id }, 400, "bad_role"],
      [{ id: "0", role: "viewer" }, 400, "bad_id"],
      [{ id: "12abc", role: "viewer" }, 400, "bad_id"],
      [{ id: "9".repeat(25), role: "viewer" }, 400, "bad_id"],
      [{ id: { toString: 1 }, role: "viewer" }, 400, "bad_id"],
    ] as const) {
      const r = await api(dev, "POST", `${base}/shares`, body, env);
      expect([r.status, ((await r.json()) as { error: string }).error], JSON.stringify(body)).toEqual([status, error]);
    }
    expect((await api(dev, "POST", `${base}/shares/lookup`, { login: "not a login!" }, env)).status).toBe(400);
    expect((await api(dev, "POST", `${base}/shares/lookup`, { login: "nobody-here" }, env)).status).toBe(400);
    expect(((await (await api(dev, "POST", `${base}/shares/lookup`, { login: "share-owner" }, env)).json()) as { error: string }).error).toBe("own_account");
    expect((await api(dev, "POST", `${base}/shares`, { id: String(numeric(owner)), role: "viewer" }, env)).status).toBe(400);
    expect((await api(dev, "POST", `${base}/shares`, { id, role: "viewer" }, env)).status).toBe(200);
    expect(((await (await api(dev, "POST", `${base}/shares`, { id, role: "viewer" }, env)).json()) as { error: string }).error).toBe("already_shared");
    expect((await api(dev, "POST", `${base}/shares/lookup`, { login: "app-guest-3" }, env)).status).toBe(409);
    // The owner's own row is never touched, by role or by remove.
    expect((await api(dev, "POST", `${base}/shares/${owner.id}/role`, { role: "viewer" }, env)).status).toBe(404);
    expect((await api(dev, "POST", `${base}/shares/${owner.id}/remove`, undefined, env)).status).toBe(404);
    expect((await api(dev, "POST", `${base}/shares/${guest.id}/role`, { role: "owner" }, env)).status).toBe(400);
    expect((await api(dev, "POST", `${base}/shares/not-an-id/role`, { role: "viewer" }, env)).status).toBe(404);
    const owners = await testEnv.DB.prepare("SELECT user_id FROM members WHERE role = 'owner' AND robot_id = ?").bind(base.split("/").pop()!).all();
    expect(owners.results.map((r) => r.user_id)).toEqual([owner.id]);
    // Methods and bodies.
    expect((await api(dev, "DELETE", `${base}/shares`, undefined, env)).status).toBe(405);
    expect((await api(dev, "GET", `${base}/shares/lookup`, undefined, env)).status).toBe(405);
    expect((await api(dev, "GET", `${base}/leave`, undefined, env)).status).toBe(405);
    expect((await api(dev, "POST", `${base}/shares/lookup`, undefined, env)).status).toBe(400);
    expect((await api(dev, "POST", "/v1/app/robots/not-a-robot/shares/lookup", { login: "x" }, env)).status).toBe(404);
  });

  it("stops at the share limit, and for an owner the admin removed", async () => {
    const { owner, dev, base } = await ownerWithRobot();
    for (let i = 0; i < MAX_SHARES_PER_ROBOT; i++) {
      const g = await newUser(`app-limit-${i}`);
      // 10 shares an hour is the owner's budget too, so write the members directly.
      await testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)").bind(base.split("/").pop()!, g.id, nowSeconds()).run();
    }
    const extra = await newUser("app-extra");
    accounts.push({ id: numeric(extra), login: "app-extra" });
    const full = await api(dev, "POST", `${base}/shares`, { id: String(numeric(extra)), role: "viewer" }, env);
    expect([full.status, ((await full.json()) as { error: string }).error]).toEqual([403, "share_limit"]);
    // An owner the admin removed is not let in at all, here or on any other call.
    await testEnv.DB.prepare("DELETE FROM invites WHERE user_id = ?").bind(owner.id).run();
    expect((await api(dev, "GET", `${base}/shares`, undefined, env)).status).toBe(403);
  });

  it("lets a guest leave, which signs the app out when it was their last share", async () => {
    const { dev, base } = await ownerWithRobot();
    const guest = await newUser("app-guest-4");
    expect((await shareWith(dev, base, guest, "app-guest-4", "viewer")).status).toBe(200);
    const gdev = (await signedIn(guest, env)).dev;
    const left = await api(gdev, "POST", `${base}/leave`, undefined, env);
    expect([left.status, await left.json()]).toEqual([200, { ok: true, signedOut: true }]);
    expect((await api(gdev, "GET", "/v1/app/robots", undefined, env)).status).toBe(401);
    expect((await api(dev, "GET", `${base}/shares`, undefined, env)).status).toBe(200);
  });

  it("lets a guest leave one share and stay signed in while they have another", async () => {
    const a = await ownerWithRobot();
    const b = await ownerWithRobot();
    const guest = await newUser("app-guest-5");
    expect((await shareWith(a.dev, a.base, guest, "app-guest-5", "viewer")).status).toBe(200);
    expect((await shareWith(b.dev, b.base, guest, "app-guest-5", "operator")).status).toBe(200);
    const gdev = (await signedIn(guest, env)).dev;
    const left = await api(gdev, "POST", `${a.base}/leave`, undefined, env);
    expect([left.status, await left.json()]).toEqual([200, { ok: true, signedOut: false }]);
    const mine = (await (await api(gdev, "GET", "/v1/app/robots", undefined, env)).json()) as { robots: { robotId: string }[] };
    expect(mine.robots.map((r) => r.robotId)).toEqual([b.base.split("/").pop()]);
  });

  it("lets the owner sign everyone out of a robot and unlink it, and nobody else", async () => {
    const { dev, base } = await ownerWithRobot();
    const robotId = base.split("/").pop()!;
    const guest = await newUser("app-guest-6");
    expect((await shareWith(dev, base, guest, "app-guest-6", "operator")).status).toBe(200);
    const gdev = (await signedIn(guest, env)).dev;
    const epoch = async () => (await testEnv.DB.prepare("SELECT session_epoch AS e FROM robots WHERE robot_id = ?").bind(robotId).first<{ e: number }>())!.e;

    // A person it is shared with can do neither, and nothing changes.
    const before = await epoch();
    for (const p of ["unlink", "sessions/revoke"]) expect((await api(gdev, "POST", `${base}/${p}`, undefined, env)).status, p).toBe(404);
    expect(await epoch()).toBe(before);
    expect((await api(gdev, "GET", "/v1/app/robots", undefined, env)).status).toBe(200);
    // Wrong method.
    expect((await api(dev, "GET", `${base}/unlink`, undefined, env)).status).toBe(405);
    expect((await api(dev, "POST", "/v1/app/robots/not-a-robot/unlink", undefined, env)).status).toBe(404);

    // Sign everyone out: the epoch goes up, the robot stays linked and shared.
    expect((await api(dev, "POST", `${base}/sessions/revoke`, undefined, env)).status).toBe(200);
    expect(await epoch()).toBe(before + 1);
    expect(((await (await api(dev, "GET", `${base}/shares`, undefined, env)).json()) as { shares: unknown[] }).shares).toHaveLength(1);

    // Unlink: gone for the owner, and the guest, whose last share it was, is signed out.
    expect((await api(dev, "POST", `${base}/unlink`, undefined, env)).status).toBe(200);
    expect(((await (await api(dev, "GET", "/v1/app/robots", undefined, env)).json()) as { robots: unknown[] }).robots).toEqual([]);
    expect((await api(gdev, "GET", "/v1/app/robots", undefined, env)).status).toBe(401);
    expect((await api(dev, "POST", `${base}/unlink`, undefined, env)).status).toBe(404);
    expect((await api(dev, "POST", `${base}/sessions/revoke`, undefined, env)).status).toBe(404);
  });

  it("needs a signed call", async () => {
    const { base } = await ownerWithRobot();
    for (const [m, p] of [["GET", `${base}/shares`], ["POST", `${base}/shares/lookup`], ["POST", `${base}/leave`]] as const) {
      const r = await call(p, { method: m, headers: { "Content-Type": "application/json" }, body: m === "POST" ? "{}" : undefined }, env);
      expect(r.status, p).toBe(401);
    }
  });
});
