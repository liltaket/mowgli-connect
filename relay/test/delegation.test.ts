import { describe, expect, it, vi } from "vitest";
import { b64urlEncode, deriveRobotId, signJws } from "../src/crypto";
import { b64urlDecode } from "../src/crypto";
import { bodyHash, fingerprint, verifyDelegateAssertion } from "../src/delegateAuth";
import { unlinkRobot } from "../src/claim";
import { APPROVALS_PER_HOUR, CALLS_PER_HOUR, GRANTS_PER_ROBOT_PER_HOUR, MAX_ACTIVE_DELEGATIONS, MAX_CLAIMED_ROBOTS, WRONG_CODES_PER_HOUR } from "../src/delegation";
import { createProvisioner } from "../src/provisioner";
import type { Env } from "../src/env";
import { nowSeconds, randomToken } from "../src/util";
import { assertion, call, decodeJws, newRobot, newUser, ORIGIN, register, registerAndClaim, testEnv, type TestRobot, type TestUser } from "./helpers";

const env: Env = { ...testEnv, DELEGATION_USERS: "*" };
const db = testEnv.DB;

interface Delegate {
  key: CryptoKey;
  publicKey: string;
  id: string;
}

async function newDelegate(): Promise<Delegate> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { key: pair.privateKey, publicKey: b64urlEncode(raw), id: await deriveRobotId(raw) };
}

async function sign(dl: Delegate, method: string, path: string, body = "", over: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const now = nowSeconds();
  const claims = { iss: dl.id, aud: ORIGIN, htm: method, htu: `${ORIGIN}${path}`, bdh: await bodyHash(body), iat: now, exp: now + 60, jti: randomToken(16), ...over };
  return `MC-Delegate ${await signJws({ alg: "EdDSA", typ: "mc-delegate+jwt", ...header }, claims, dl.key)}`;
}

async function api(dl: Delegate, method: string, path: string, body?: unknown, e: Env = env): Promise<Response> {
  const text = body === undefined ? "" : JSON.stringify(body);
  return call(
    path,
    { method, headers: { Authorization: await sign(dl, method, path, text), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : text },
    e,
  );
}

async function loginOf(u: TestUser): Promise<string> {
  return (await db.prepare("SELECT login FROM users WHERE id = ?").bind(u.id).first<{ login: string }>())!.login;
}

interface ConsentOptions {
  name?: string;
  ttl?: number;
  claims?: Record<string, unknown>;
  signWith?: CryptoKey;
}

/** The consent link's query, signed with the delegate key for `who`'s account, as the CLI does. */
async function consentQuery(who: TestUser | string, dl: Delegate, scopes: string[], o: ConsentOptions = {}): Promise<URLSearchParams> {
  const account = typeof who === "string" ? who : await loginOf(who);
  const uid = typeof who === "string" ? "gh:0" : who.id;
  const now = nowSeconds();
  const claims = { iss: dl.id, aud: ORIGIN, account, uid, name: o.name ?? "Test agent", scopes: scopes.join(" "), ttl: o.ttl ?? 86400, iat: now, exp: now + 1200, ...o.claims };
  return new URLSearchParams({ key: dl.publicKey, req: await signJws({ alg: "EdDSA", typ: "mc-delegate-request+jwt" }, claims, o.signWith ?? dl.key) });
}

function getPage(path: string, user: TestUser | null, e: Env = env): Promise<Response> {
  return call(path, { headers: user ? { Cookie: user.cookie } : {}, redirect: "manual" }, e);
}

function postForm(path: string, user: TestUser, form: URLSearchParams, origin: string | null = ORIGIN, e: Env = env): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Cookie: user.cookie };
  if (origin) headers.Origin = origin;
  return call(path, { method: "POST", headers, body: form.toString(), redirect: "manual" }, e);
}

async function approvalForm(
  who: TestUser | string,
  dl: Delegate,
  scopes: string[],
  robots: string[] = [],
  o: ConsentOptions & { requested?: string[]; confirm?: boolean } = {},
): Promise<URLSearchParams> {
  const f = await consentQuery(who, dl, o.requested ?? scopes, o);
  f.set("ttl", String(o.ttl ?? 86400));
  for (const s of scopes) f.append("scope", s);
  for (const r of robots) f.append("robot", r);
  if (o.confirm !== false) f.set("confirm", "yes");
  f.set("decision", "allow");
  return f;
}

/** Runs the consent page and approves it. */
async function approve(user: TestUser, dl: Delegate, scopes: string[], robots: string[] = [], o: { ttl?: number; name?: string } = {}): Promise<void> {
  const page = await getPage(`/delegate/authorize?${await consentQuery(user, dl, scopes, o)}`, user);
  expect(page.status).toBe(200);
  const res = await postForm("/delegate/authorize", user, await approvalForm(user, dl, scopes, robots, o));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Approved");
}

async function delegated(scopes: string[], robots: number = 0) {
  const user = await newUser();
  const owned: TestRobot[] = [];
  for (let i = 0; i < robots; i++) owned.push((await registerAndClaim(user, `Mower ${randomToken(3)}`)).robot);
  const dl = await newDelegate();
  await approve(user, dl, scopes, owned.map((r) => r.robotId));
  return { user, dl, owned };
}

async function members(robot: TestRobot, e: Env = env): Promise<{ userId: string; role: string }[]> {
  const res = await call("/v1/robots/self", { headers: { Authorization: await assertion(robot, "GET", "/v1/robots/self") } }, e);
  return ((await res.json()) as { members: { userId: string; role: string }[] }).members;
}

const events = (id: string) =>
  db.prepare("SELECT actor, action, robot_id, outcome FROM delegation_events WHERE delegation_id = ? ORDER BY id").bind(id).all<Record<string, string | null>>().then((r) => r.results);

const ALL = ["robots:read", "robots:claim", "robots:manage", "sessions:readonly"];

describe("delegation off by default", () => {
  it("answers 404 everywhere without DELEGATION_USERS", async () => {
    const user = await newUser();
    const dl = await newDelegate();
    expect((await api(dl, "GET", "/v1/delegate/self", undefined, testEnv)).status).toBe(404);
    expect((await getPage(`/delegate/authorize?${await consentQuery(user, dl, ["robots:read"])}`, user, testEnv)).status).toBe(404);
    expect(await (await getPage("/", user, testEnv)).text()).not.toContain("AI agents");
    const appOff: Env = { ...testEnv, APP_IOS_APP_IDS: "ABCDE12345.garden.mowgli.app" };
    expect((await call("/v1/app/delegations", {}, appOff)).status).toBe(404);
    expect((await call(`/v1/app/delegations/${dl.id}/revoke`, { method: "POST" }, appOff)).status).toBe(404);
  });

  it("is only for the people DELEGATION_USERS names", async () => {
    const user = await newUser();
    const other = await newUser();
    const e = { ...env, DELEGATION_USERS: ` ${user.id.toUpperCase()} ` };
    const dl = await newDelegate();
    expect((await getPage(`/delegate/authorize?${await consentQuery(other, dl, ["robots:read"])}`, other, e)).status).toBe(404);
    expect(await (await getPage("/", other, e)).text()).not.toContain("AI agents");
    expect(await (await getPage("/", user, e)).text()).toContain("AI agents");
    expect((await getPage(`/delegate/authorize?${await consentQuery(user, dl, ["robots:read"])}`, user, e)).status).toBe(200);
  });
});

describe("consent", () => {
  it("shows the agent, the fingerprint, the scopes and the robots, and writes nothing", async () => {
    const user = await newUser();
    const { robot } = await registerAndClaim(user, "Front Lawn");
    const dl = await newDelegate();
    const res = await getPage(`/delegate/authorize?${await consentQuery(user, dl, ["robots:read", "sessions:readonly"], { name: "Claude <b>laptop</b>" })}`, user);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const text = await res.text();
    expect(text).toContain("Claude &lt;b&gt;laptop&lt;/b&gt;");
    expect(text).toContain(fingerprint(dl.id));
    expect(text).toContain('value="robots:read" checked');
    expect(text).not.toContain('value="robots:manage"');
    expect(text).toContain(`name="robot" value="${robot.robotId}">`); // not ticked
    expect(text).toContain('name="confirm" value="yes" required');
    expect(await db.prepare("SELECT COUNT(*) AS n FROM delegations WHERE delegation_id = ?").bind(dl.id).first()).toEqual({ n: 0 });
  });

  it("marks simulators, lists what it can never do, and names the ticked robots once approved", async () => {
    const user = await newUser();
    const { robot: mower } = await registerAndClaim(user, "Back Lawn");
    const { robot: sim } = await registerAndClaim(user, "Farm robot");
    await db.prepare("UPDATE robots SET simulator = 1 WHERE robot_id = ?").bind(sim.robotId).run();
    const dl = await newDelegate();
    const text = await (await getPage(`/delegate/authorize?${await consentQuery(user, dl, ["robots:read"])}`, user)).text();
    expect(text).toContain('Farm robot<span class="sim">Simulator</span>');
    expect(text).toContain('Back Lawn</span>');
    expect(text).not.toContain('Back Lawn<span class="sim">');
    expect(text).toContain("Drive a robot or start mowing");
    const done = await (await postForm("/delegate/authorize", user, await approvalForm(user, dl, ["robots:read"], [sim.robotId]))).text();
    expect(done).toContain("<dd>Farm robot</dd>");
    expect(done).not.toContain(mower.robotId);
  });

  it("sends a signed-out person through sign-in", async () => {
    const dl = await newDelegate();
    const res = await getPage(`/delegate/authorize?${await consentQuery("nobody", dl, ["robots:read"])}`, null);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/login\?return_to=%2Fdelegate%2Fauthorize/);
  });

  it("refuses rights that do not exist, and bad links", async () => {
    const user = await newUser();
    const dl = await newDelegate();
    for (const scopes of [["robots:read", "robots:drive"], ["sessions:owner"], ["admin"], []]) {
      expect((await getPage(`/delegate/authorize?${await consentQuery(user, dl, scopes)}`, user)).status).toBe(400);
    }
    expect((await getPage(`/delegate/authorize?key=abc&req=x`, user)).status).toBe(400);
    expect((await getPage(`/delegate/authorize?key=${dl.publicKey}`, user)).status).toBe(400);
    expect((await getPage(`/delegate/authorize?${await consentQuery(user, dl, ["robots:read"], { name: "" })}`, user)).status).toBe(400);
  });

  it("needs our Origin, the confirmation box and only requested scopes and own robots", async () => {
    const user = await newUser();
    const stranger = await newUser();
    const { robot: theirs } = await registerAndClaim(stranger);
    const dl = await newDelegate();
    const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM delegations WHERE delegation_id = ?").bind(dl.id).first<{ n: number }>())!.n;
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, dl, ["robots:read"]), "https://evil.test")).status).toBe(403);
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, dl, ["robots:read"]), null)).status).toBe(403);
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, dl, ["robots:read"], [], { confirm: false }))).status).toBe(400);
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, dl, ["robots:read", "robots:manage"], [], { requested: ["robots:read"] }))).status).toBe(400);
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, dl, ["robots:read"], [theirs.robotId]))).status).toBe(409);
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, dl, ["robots:read"], [], { ttl: 99 * 86400 }))).status).toBe(400);
    const deny = await approvalForm(user, dl, ["robots:read"]);
    deny.set("decision", "deny");
    expect(await (await postForm("/delegate/authorize", user, deny)).text()).toContain("Nothing was changed");
    expect(await count()).toBe(0);
  });

  it("snaps a requested duration down to an offered one", async () => {
    const user = await newUser();
    const dl = await newDelegate();
    const text = await (await getPage(`/delegate/authorize?${await consentQuery(user, dl, ["robots:read"], { ttl: 2 * 86400 })}`, user)).text();
    expect(text).toContain('name="ttl" value="86400" checked required>');
  });

  it("a key belongs to one person", async () => {
    const { dl } = await delegated(["robots:read"]);
    const other = await newUser();
    expect((await getPage(`/delegate/authorize?${await consentQuery(other, dl, ["robots:read"])}`, other)).status).toBe(409);
    expect((await postForm("/delegate/authorize", other, await approvalForm(other, dl, ["robots:read"]))).status).toBe(409);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM delegations WHERE user_id = ?").bind(other.id).first<{ n: number }>())!.n).toBe(0);
  });

  it(`allows at most ${MAX_ACTIVE_DELEGATIONS} active delegations per person`, async () => {
    const user = await newUser();
    for (let i = 0; i < MAX_ACTIVE_DELEGATIONS; i++) await approve(user, await newDelegate(), ["robots:read"]);
    const extra = await newDelegate();
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, extra, ["robots:read"]))).status).toBe(403);
  });

  it("approving again replaces the scopes, the ticked robots and the expiry", async () => {
    const { user, dl, owned } = await delegated(["robots:read", "robots:manage"], 2);
    await approve(user, dl, ["robots:read"], [owned[0]!.robotId], { ttl: 3600 });
    const self = (await (await api(dl, "GET", "/v1/delegate/self")).json()) as { scopes: string[]; robots: string[]; expiresAt: number };
    expect(self.scopes).toEqual(["robots:read"]);
    expect(self.robots).toEqual([owned[0]!.robotId]);
    expect(self.expiresAt).toBeLessThanOrEqual(nowSeconds() + 3600);
  });
});

describe("signed delegate calls", () => {
  it("work once, only for the signed method, URL and body", async () => {
    const { dl } = await delegated(["robots:read", "robots:claim"]);
    const ok = await api(dl, "GET", "/v1/delegate/self");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ delegateId: dl.id, name: "Test agent", scopes: ["robots:read", "robots:claim"] });

    const auth = await sign(dl, "GET", "/v1/delegate/self");
    expect((await call("/v1/delegate/self", { headers: { Authorization: auth } }, env)).status).toBe(200);
    const replay = await call("/v1/delegate/self", { headers: { Authorization: auth } }, env);
    expect(await replay.json()).toMatchObject({ detail: "replayed_jti" });

    // A signature for one body does not carry another one.
    const signedFor = JSON.stringify({ code: "a-b-c", step: "preview" });
    const swapped = await call(
      "/v1/delegate/claim",
      { method: "POST", headers: { Authorization: await sign(dl, "POST", "/v1/delegate/claim", signedFor), "Content-Type": "application/json" }, body: JSON.stringify({ code: "x-y-z", step: "confirm" }) },
      env,
    );
    expect(swapped.status).toBe(401);
    expect(await swapped.json()).toMatchObject({ detail: "bad_bdh" });

    const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
      [{ htu: `${ORIGIN}/v1/delegate/robots` }, {}, "bad_htu"],
      [{ htm: "POST" }, {}, "bad_htm"],
      [{ aud: "https://other.test" }, {}, "bad_aud"],
      [{ exp: nowSeconds() + 600 }, {}, "bad_lifetime"],
      [{ iat: nowSeconds() - 300, exp: nowSeconds() - 250 }, {}, "expired"],
      [{ jti: "short" }, {}, "bad_jti"],
      [{}, { typ: "mc-robot+jwt" }, "bad_header"],
    ];
    for (const [over, header, detail] of cases) {
      const res = await call("/v1/delegate/self", { headers: { Authorization: await sign(dl, "GET", "/v1/delegate/self", "", over, header) } }, env);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ detail });
    }
  });

  it("accepts the Go client's signature (delegate/internal/client TestSignatureVector)", async () => {
    // Seed 0x01..0x20; the same token is produced byte for byte by the Go client's test.
    const pub = b64urlDecode("ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ");
    const jws =
      "eyJhbGciOiJFZERTQSIsInR5cCI6Im1jLWRlbGVnYXRlK2p3dCJ9.eyJhdWQiOiJodHRwczovL3JlbGF5LnRlc3QiLCJiZGgiOiJYY043NVRvaFNGTkNBN05rVUhRajRGT0MzeHU2djltY3gtbDJjRjBYQlJBIiwiZXhwIjoxNzk0MDAwMDYwLCJodG0iOiJQT1NUIiwiaHR1IjoiaHR0cHM6Ly9yZWxheS50ZXN0L3YxL2RlbGVnYXRlL2NsYWltIiwiaWF0IjoxNzk0MDAwMDAwLCJpc3MiOiJtdzNhbTQ2dzV3ZWV4NGE0IiwianRpIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIn0.w-ipKIO5uXifzX3LTYI72UuJkteJBvH70YH2Cs1jyLgxt1WwsLLgdddZJZWILPX4ttiv_fyIZbVVBiya5K7RDQ";
    const verify = (body: string) =>
      verifyDelegateAssertion({
        authorization: `MC-Delegate ${jws}`,
        method: "POST",
        htu: `${ORIGIN}/v1/delegate/claim`,
        aud: ORIGIN,
        body,
        now: 1794000010,
        resolveKey: async (iss) => (iss === "mw3am46w5weex4a4" ? pub : null),
      });
    expect(await verify('{"code":"lemon-otter-crisp","step":"preview"}')).toMatchObject({ delegateId: "mw3am46w5weex4a4", exp: 1794000060 });
    await expect(verify('{"code":"lemon-otter-crisp","step":"confirm"}')).rejects.toMatchObject({ code: "bad_bdh" });
    expect(fingerprint("mw3am46w5weex4a4")).toBe("mw3a-m46w-5wee-x4a4");
  });

  it("an unknown or wrongly signed key writes nothing", async () => {
    const dl = await newDelegate();
    // Replay records only: an approval's one-time token ('apv:') is not one.
    const replayRecords = "SELECT COUNT(*) AS n FROM jti_seen WHERE robot_id NOT LIKE 'apv:%'";
    const before = await db.prepare(replayRecords).first<{ n: number }>();
    const res = await api(dl, "GET", "/v1/delegate/self");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ detail: "unknown_delegate" });
    const { dl: real } = await delegated(["robots:read"]);
    const forged = await call("/v1/delegate/self", { headers: { Authorization: await sign(dl, "GET", "/v1/delegate/self", "", { iss: real.id }) } }, env);
    expect(await forged.json()).toMatchObject({ detail: "bad_signature" });
    expect(await events(real.id)).toEqual([expect.objectContaining({ actor: "person", action: "approve" })]);
    expect((await db.prepare(replayRecords).first<{ n: number }>())!.n).toBe(before!.n);
  });

  it("refuses a missing scope and logs the attempt", async () => {
    const { dl, owned } = await delegated(["robots:read"], 1);
    const res = await api(dl, "POST", "/v1/delegate/claim", { code: "a-b-c", step: "preview" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "scope_required", scope: "robots:claim" });
    expect((await api(dl, "POST", `/v1/delegate/robots/${owned[0]!.robotId}/unlink`, {})).status).toBe(403);
    expect((await api(dl, "POST", `/v1/delegate/robots/${owned[0]!.robotId}/grant`, {})).status).toBe(403);
    expect((await events(dl.id)).filter((e) => e.outcome === "denied").map((e) => e.action)).toEqual(["claim", "unlink", "grant"]);
    expect(await members(owned[0]!)).toHaveLength(1);
  });

  it("stops at once when the person loses access", async () => {
    const { user, dl } = await delegated(["robots:read"]);
    expect((await api(dl, "GET", "/v1/delegate/self", undefined, { ...env, DELEGATION_USERS: "gh:1" })).status).toBe(403);
    expect((await api(dl, "GET", "/v1/delegate/self", undefined, { ...env, ALLOWED_GITHUB_LOGINS: "" })).status).toBe(403);
    expect(user.id).toMatch(/^gh:/);
  });
});

describe("the robot set", () => {
  it("lists only ticked robots, and nothing else is reachable", async () => {
    const user = await newUser();
    const { robot: ticked } = await registerAndClaim(user, "Back Lawn");
    const { robot: hidden } = await registerAndClaim(user, "Real Mower");
    const dl = await newDelegate();
    await approve(user, dl, ALL, [ticked.robotId]);
    const list = (await (await api(dl, "GET", "/v1/delegate/robots")).json()) as { robots: { robotId: string; addedByDelegate: boolean }[] };
    expect(list.robots).toEqual([expect.objectContaining({ robotId: ticked.robotId, addedByDelegate: false, role: "owner", simulator: false })]);
    for (const action of ["grant", "unlink", "label"]) {
      const res = await api(dl, "POST", `/v1/delegate/robots/${hidden.robotId}/${action}`, { label: "x" });
      expect(res.status).toBe(404);
    }
    expect(await members(hidden)).toEqual([{ userId: user.id, role: "owner" }]);
  });

  it("labels a robot for the person", async () => {
    const { user, dl, owned } = await delegated(["robots:manage"], 1);
    const res = await api(dl, "POST", `/v1/delegate/robots/${owned[0]!.robotId}/label`, { label: "Sim‮ run 7" });
    expect(await res.json()).toEqual({ robotId: owned[0]!.robotId, label: "Sim run 7" });
    expect(await db.prepare("SELECT label FROM members WHERE robot_id = ? AND user_id = ?").bind(owned[0]!.robotId, user.id).first()).toEqual({ label: "Sim run 7" });
  });

  it("unlinks only robots the person owns, and an unlinked robot leaves the set for good", async () => {
    const { user, dl, owned } = await delegated(["robots:manage", "robots:read"], 1);
    const robot = owned[0]!;
    const res = await api(dl, "POST", `/v1/delegate/robots/${robot.robotId}/unlink`, {});
    expect(await res.json()).toEqual({ ok: true });
    expect(await db.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robot.robotId).first()).toEqual({ status: "revoked" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM delegation_robots WHERE robot_id = ?").bind(robot.robotId).first()).toEqual({ n: 0 });

    // The person adds it again by hand: it does not come back to the agent.
    await db.prepare("UPDATE pairing_codes SET created_at = created_at - 120 WHERE robot_id = ?").bind(robot.robotId).run();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const again = await postForm("/claim", user, new URLSearchParams({ code: pairingCode }));
    expect(again.status).toBe(303);
    expect(((await (await api(dl, "GET", "/v1/delegate/robots")).json()) as { robots: unknown[] }).robots).toEqual([]);
  });

  it("refuses to unlink a robot the person only views", async () => {
    const owner = await newUser();
    const { robot } = await registerAndClaim(owner);
    const viewer = await newUser();
    await db.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)").bind(robot.robotId, viewer.id, nowSeconds()).run();
    const dl = await newDelegate();
    await approve(viewer, dl, ["robots:manage"], [robot.robotId]);
    const res = await api(dl, "POST", `/v1/delegate/robots/${robot.robotId}/unlink`, {});
    expect(res.status).toBe(403);
    expect(await db.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robot.robotId).first()).toEqual({ status: "claimed" });
  });
});

describe("claiming robots", () => {
  it("adds a robot with a pairing code; it is the person's and joins the set", async () => {
    const { user, dl } = await delegated(["robots:claim", "robots:read"]);
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "Sim Run 1")).json()) as { pairingCode: string };
    const prev = await api(dl, "POST", "/v1/delegate/claim", { code: pairingCode, step: "preview" });
    expect(await prev.json()).toMatchObject({ robotId: robot.robotId, name: "Sim Run 1", hostname: "sim-run-1.robots.test" });
    const done = await api(dl, "POST", "/v1/delegate/claim", { code: pairingCode, step: "confirm", label: "Sim Run 1" });
    expect(await done.json()).toEqual({ robotId: robot.robotId, hostname: "sim-run-1.robots.test" });
    expect(await members(robot)).toEqual([{ userId: user.id, role: "owner" }]); // no sessions scope: not a member itself
    const list = (await (await api(dl, "GET", "/v1/delegate/robots")).json()) as { robots: { robotId: string; addedByDelegate: boolean }[] };
    expect(list.robots).toEqual([expect.objectContaining({ robotId: robot.robotId, addedByDelegate: true })]);
    expect(await (await getPage("/", user)).text()).toContain("Added by Test agent");
    expect((await events(dl.id)).map((e) => [e.action, e.outcome, e.robot_id])).toContainEqual(["claim", "ok", robot.robotId]);
  });

  it(`has its own guess budget (${WRONG_CODES_PER_HOUR} an hour), so the person can still add robots`, async () => {
    const { user, dl } = await delegated(["robots:claim"]);
    for (let i = 0; i < WRONG_CODES_PER_HOUR; i++) {
      expect((await api(dl, "POST", "/v1/delegate/claim", { code: "lemon-otter-crisp", step: "preview" })).status).toBe(400);
    }
    expect((await api(dl, "POST", "/v1/delegate/claim", { code: "lemon-otter-crisp", step: "preview" })).status).toBe(429);
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    expect((await api(dl, "POST", "/v1/delegate/claim", { code: pairingCode, step: "confirm" })).status).toBe(429);
    expect((await postForm("/claim", user, new URLSearchParams({ code: pairingCode }))).status).toBe(303);
  });

  it(`stops at ${MAX_CLAIMED_ROBOTS} robots it added that are still linked`, async () => {
    const { dl } = await delegated(["robots:claim"]);
    const now = nowSeconds();
    // Pretend it already added the maximum (robots claimed by this person, in its set).
    for (let i = 0; i < MAX_CLAIMED_ROBOTS; i++) {
      const { robot } = await registerAndClaim(await newUser());
      await db.prepare("INSERT INTO delegation_robots (delegation_id, robot_id, via, added_at) VALUES (?, ?, 'claim', ?)").bind(dl.id, robot.robotId, now).run();
    }
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const res = await api(dl, "POST", "/v1/delegate/claim", { code: pairingCode, step: "confirm" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "claim_limit" });
    expect(await db.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robot.robotId).first()).toEqual({ status: "unclaimed" });
  });

  it("keeps to the person's robot limit", async () => {
    const { user, dl } = await delegated(["robots:claim"]);
    await db.prepare("INSERT INTO invites (user_id, login, robot_limit, invited_by, created_at) VALUES (?, 'x', 0, 'gh:1', ?)").bind(user.id, nowSeconds()).run();
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const res = await api(dl, "POST", "/v1/delegate/claim", { code: pairingCode, step: "confirm" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "robot_limit" });
  });
});

describe("read-only robot sessions", () => {
  it("grants a viewer session as the delegate's own identity, which the robot lists as a viewer", async () => {
    const { user, dl, owned } = await delegated(["sessions:readonly"], 1);
    const robot = owned[0]!;
    const epoch = (await db.prepare("SELECT session_epoch FROM robots WHERE robot_id = ?").bind(robot.robotId).first<{ session_epoch: number }>())!.session_epoch;
    const res = await api(dl, "POST", `/v1/delegate/robots/${robot.robotId}/grant`, {});
    expect(res.status).toBe(200);
    const { grant, hostname } = (await res.json()) as { grant: string; hostname: string };
    expect(hostname).toMatch(/\.robots\.test$/);
    const { header, payload } = decodeJws(grant);
    expect(header).toMatchObject({ typ: "mc-grant+jwt" });
    expect(payload).toMatchObject({ aud: `mc-robot:${robot.robotId}`, sub: `dlg:${dl.id}`, role: "viewer", epoch });
    expect(payload.name).toMatch(/^Test agent \(agent for @user/);
    expect(await members(robot)).toEqual([
      { userId: user.id, role: "owner" },
      { userId: `dlg:${dl.id}`, role: "viewer" },
    ]);
    // Without the feature, robots forget delegates.
    expect(await members(robot, testEnv)).toEqual([{ userId: user.id, role: "owner" }]);
  });

  it("revoking from the robots page ends it at the robot's next sync, without signing anyone else out", async () => {
    const { user, dl, owned } = await delegated(["sessions:readonly", "robots:read"], 1);
    const robot = owned[0]!;
    const epoch = async () => (await db.prepare("SELECT session_epoch FROM robots WHERE robot_id = ?").bind(robot.robotId).first<{ session_epoch: number }>())!.session_epoch;
    const before = await epoch();
    expect(await members(robot)).toContainEqual({ userId: `dlg:${dl.id}`, role: "viewer" });
    expect(await (await getPage("/", user)).text()).toContain(`/delegations/${dl.id}/revoke`);
    const res = await postForm(`/delegations/${dl.id}/revoke`, user, new URLSearchParams());
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/?notice=delegation_revoked");
    expect(await members(robot)).toEqual([{ userId: user.id, role: "owner" }]);
    expect(await epoch()).toBe(before);
    expect(await (await api(dl, "GET", "/v1/delegate/robots")).json()).toEqual({ error: "delegation_revoked" });
    expect((await api(dl, "POST", `/v1/delegate/robots/${robot.robotId}/grant`, {})).status).toBe(401);
  });

  it("ends when the delegation expires, and renewing brings it back", async () => {
    const { user, dl, owned } = await delegated(["sessions:readonly"], 1);
    await db.prepare("UPDATE delegations SET expires_at = ? WHERE delegation_id = ?").bind(nowSeconds() - 1, dl.id).run();
    expect(await (await api(dl, "GET", "/v1/delegate/self")).json()).toEqual({ error: "delegation_expired" });
    expect(await members(owned[0]!)).toEqual([{ userId: user.id, role: "owner" }]);
    expect(await (await getPage("/", user)).text()).toContain("Expired");
    expect((await postForm(`/delegations/${dl.id}/renew`, user, new URLSearchParams())).headers.get("Location")).toBe("/?notice=delegation_renewed");
    expect((await api(dl, "GET", "/v1/delegate/self")).status).toBe(200);
    expect(await members(owned[0]!)).toContainEqual({ userId: `dlg:${dl.id}`, role: "viewer" });
  });

  it("drops a delegate from the robot when its person is no longer a member", async () => {
    const { user, dl, owned } = await delegated(["sessions:readonly"], 1);
    await db.prepare("DELETE FROM members WHERE robot_id = ? AND user_id = ?").bind(owned[0]!.robotId, user.id).run();
    expect(await members(owned[0]!)).toEqual([]);
  });
});

describe("revocation, renewal and the activity log", () => {
  it("the agent can revoke itself, but nobody else's delegation", async () => {
    const { user, dl } = await delegated(["robots:read"]);
    const other = await newUser();
    expect((await postForm(`/delegations/${dl.id}/revoke`, other, new URLSearchParams())).status).toBe(404);
    expect((await postForm(`/delegations/${dl.id}/renew`, other, new URLSearchParams())).status).toBe(404);
    expect((await getPage(`/delegations/${dl.id}`, other)).status).toBe(404);
    expect((await postForm(`/delegations/${dl.id}/revoke`, user, new URLSearchParams(), "https://evil.test")).status).toBe(403);
    expect(await (await api(dl, "POST", "/v1/delegate/revoke", {})).json()).toEqual({ ok: true });
    expect((await api(dl, "GET", "/v1/delegate/self")).status).toBe(401);
    // A revoked key is revoked for good: no renewal, no new approval (security review 14).
    expect((await postForm(`/delegations/${dl.id}/renew`, user, new URLSearchParams())).status).toBe(404);
    const page = await getPage(`/delegate/authorize?${await consentQuery(user, dl, ["robots:read"])}`, user);
    expect(page.status).toBe(409);
    expect(await page.text()).toContain("can never be approved again");
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, dl, ["robots:read"]))).status).toBe(409);
    expect((await api(dl, "GET", "/v1/delegate/self")).status).toBe(401);
  });

  it("shows the person what the agent did", async () => {
    const { user, dl, owned } = await delegated(["robots:read"], 1);
    await api(dl, "GET", "/v1/delegate/robots");
    await api(dl, "POST", `/v1/delegate/robots/${owned[0]!.robotId}/unlink`, {});
    const page = await (await getPage(`/delegations/${dl.id}`, user)).text();
    expect(page).toContain("Test agent");
    expect(page).toContain("<td>list</td>");
    expect(page).toMatch(/<td>unlink<\/td><td>Mower [^<]*<\/td><td>denied<\/td><td>needs robots:manage<\/td>/);
    expect(page).toContain("<td>approve</td>");
  });

  it(`limits calls to ${CALLS_PER_HOUR} an hour`, async () => {
    const { dl } = await delegated(["robots:read"]);
    const now = nowSeconds();
    await db.batch(
      Array.from({ length: CALLS_PER_HOUR - 1 }, () =>
        db.prepare("INSERT INTO delegation_events (delegation_id, at, actor, action, outcome) VALUES (?, ?, 'agent', 'list', 'ok')").bind(dl.id, now - 60),
      ),
    );
    expect((await api(dl, "GET", "/v1/delegate/self")).status).toBe(200);
    const res = await api(dl, "GET", "/v1/delegate/self");
    expect(res.status).toBe(429);
    expect((await api(dl, "POST", "/v1/delegate/claim", { code: "a", step: "preview" })).status).toBe(429); // denied attempts count too
  });

  it("removing a person on the admin page revokes their delegations", async () => {
    const admin = await newUser("boss-dlg");
    const { user, dl } = await delegated(["robots:read"]);
    await db.prepare("INSERT INTO invites (user_id, login, invited_by, created_at) VALUES (?, 'x', ?, ?)").bind(user.id, admin.id, nowSeconds()).run();
    const e = { ...env, ALLOWED_GITHUB_LOGINS: "", ADMIN_GITHUB_IDS: admin.id };
    expect((await api(dl, "GET", "/v1/delegate/self", undefined, e)).status).toBe(200);
    expect((await postForm(`/admin/people/${user.id}/remove`, admin, new URLSearchParams(), ORIGIN, e)).status).toBe(303);
    expect(await (await api(dl, "GET", "/v1/delegate/self", undefined, e)).json()).toEqual({ error: "delegation_revoked" });
    expect((await events(dl.id)).at(-1)).toMatchObject({ actor: "admin", action: "revoke" });
  });
});

describe("the app: list, approve and revoke delegations", () => {
  const APP_ID = "ABCDE12345.garden.mowgli.app";
  const appEnv: Env = { ...env, APP_IOS_APP_IDS: APP_ID };
  const enc = new TextEncoder();
  const CONSENT = "/v1/app/delegations/consent";

  /** A signed-in app device for this person, inserted directly (the sign-in flow is covered in app.test.ts). */
  async function appDevice(user: TestUser) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const j = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    const jwk = { kty: "EC", crv: "P-256", x: j.x!, y: j.y! };
    const tp = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`))));
    await db.prepare("INSERT INTO devices (device_id, user_id, name, public_jwk, created_at, last_used_at) VALUES (?, ?, 'Phone', ?, ?, ?)")
      .bind(tp, user.id, JSON.stringify(jwk), nowSeconds(), nowSeconds())
      .run();
    const sign = async (method: string, path: string) => {
      const now = nowSeconds();
      const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", typ: "mc-device+jwt" })));
      const p = b64urlEncode(enc.encode(JSON.stringify({ iss: tp, aud: ORIGIN, htm: method, htu: `${ORIGIN}${path}`, iat: now, exp: now + 60, jti: randomToken(16) })));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, enc.encode(`${h}.${p}`)));
      return `MC-Device ${h}.${p}.${b64urlEncode(sig)}`;
    };
    const signed = async (method: string, path: string, body?: unknown, e: Env = appEnv, authorization?: string) => {
      const headers: Record<string, string> = { Authorization: authorization ?? (await sign(method, path)) };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return call(path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }, e);
    };
    return Object.assign(signed, { sign, deviceId: tp });
  }

  /** The consent link's two parameters, as the app reads them from the pasted or opened link. */
  async function link(who: TestUser | string, dl: Delegate, scopes: string[], o: ConsentOptions = {}) {
    const q = await consentQuery(who, dl, scopes, o);
    return { key: q.get("key")!, req: q.get("req")! };
  }

  const rows = async (id: string) => ({
    delegations: (await db.prepare("SELECT COUNT(*) AS n FROM delegations WHERE delegation_id = ?").bind(id).first<{ n: number }>())!.n,
    events: (await events(id)).length,
  });

  it("lists them and revokes one, signed by the device", async () => {
    const { user, dl } = await delegated(["robots:read"]);
    const signed = await appDevice(user);
    expect(await (await signed("GET", "/v1/app/delegations")).json()).toEqual({
      delegations: [expect.objectContaining({ delegateId: dl.id, name: "Test agent", scopes: ["robots:read"], revokedAt: null })],
    });
    expect(await (await signed("POST", `/v1/app/delegations/${dl.id}/revoke`)).json()).toEqual({ ok: true });
    expect((await signed("POST", `/v1/app/delegations/${dl.id}/revoke`)).status).toBe(404);
    expect((await events(dl.id)).at(-1)).toMatchObject({ actor: "app", action: "revoke" });
    expect((await api(dl, "GET", "/v1/delegate/self")).status).toBe(401);
  });

  it("previews what the consent page shows, and writes nothing", async () => {
    const user = await newUser();
    const { robot: mower } = await registerAndClaim(user, "Back Lawn");
    const { robot: sim } = await registerAndClaim(user, "Farm robot");
    await db.prepare("UPDATE robots SET simulator = 1 WHERE robot_id = ?").bind(sim.robotId).run();
    const signed = await appDevice(user);
    const dl = await newDelegate();
    const res = await signed("POST", CONSENT, { step: "preview", ...(await link(user, dl, ["robots:read", "robots:claim", "robots:manage"], { name: "Claude <b>laptop</b>", ttl: 2 * 86400 })) });
    expect(res.status).toBe(200);
    const v = (await res.json()) as Record<string, any>;
    expect(v).toMatchObject({
      delegateId: dl.id,
      fingerprint: fingerprint(dl.id),
      name: "Claude <b>laptop</b>", // JSON, shown as text by the app
      login: await loginOf(user),
      never: ["Drive a robot or start mowing", "Change a robot's settings or maps", "Share robots or invite people", "Give itself more access"],
      ttl: {
        choices: [
          { seconds: 3600, label: "1 hour" },
          { seconds: 28800, label: "8 hours" },
          { seconds: 86400, label: "1 day" },
          { seconds: 604800, label: "7 days" },
          { seconds: 2592000, label: "30 days" },
        ],
        default: 86400, // 2 days snapped down, as on the page
      },
      existing: null,
    });
    expect(v.linkExpiresAt).toBeGreaterThan(nowSeconds());
    expect(v.scopes.map((s: { scope: string }) => s.scope)).toEqual(["robots:read", "robots:claim", "robots:manage"]);
    expect(v.scopes[0]).toEqual({ scope: "robots:read", title: "See robots", text: expect.stringContaining("List the robots"), limits: null });
    expect(v.scopes[1].limits).toContain("At most 10 new robots an hour");
    expect(v.robotsNote).toContain("It may unlink every robot you tick that you own");
    expect(v.robots).toEqual([
      { robotId: mower.robotId, name: "Back Lawn", role: "owner", detail: "You own it", simulator: false, ticked: false, addedByAgent: false },
      { robotId: sim.robotId, name: "Farm robot", role: "owner", detail: "You own it", simulator: true, ticked: false, addedByAgent: false },
    ]);
    // The page shows the same texts.
    const text = await (await getPage(`/delegate/authorize?${await consentQuery(user, dl, ["robots:read", "robots:claim", "robots:manage"])}`, user)).text();
    for (const s of v.scopes) expect(text).toContain(s.text.replace(/'/g, "&#39;"));
    expect(text).toContain(v.robotsNote);
    expect(await rows(dl.id)).toEqual({ delegations: 0, events: 0 });
  });

  it("approves with the person's choices, through the same checks as the page", async () => {
    const user = await newUser();
    const { robot: a } = await registerAndClaim(user, "Front");
    const { robot: b } = await registerAndClaim(user, "Back");
    const signed = await appDevice(user);
    const dl = await newDelegate();
    const l = await link(user, dl, ["robots:read", "robots:manage", "sessions:readonly"]);
    const res = await signed("POST", CONSENT, { step: "approve", ...l, scopes: ["robots:read", "sessions:readonly"], robots: [b.robotId], ttl: 3600, confirm: true });
    expect(res.status).toBe(200);
    const done = (await res.json()) as Record<string, any>;
    expect(done).toMatchObject({
      approved: true,
      delegateId: dl.id,
      fingerprint: fingerprint(dl.id),
      name: "Test agent",
      scopes: [{ scope: "robots:read", title: "See robots" }, { scope: "sessions:readonly", title: "Look at a robot's own app, read-only" }],
      robots: [{ robotId: b.robotId, name: "Back" }],
    });
    expect(done.expiresAt).toBeLessThanOrEqual(nowSeconds() + 3600);
    expect((await events(dl.id)).at(-1)).toMatchObject({ actor: "app", action: "approve", outcome: "ok" });
    const self = (await (await api(dl, "GET", "/v1/delegate/self")).json()) as { scopes: string[]; robots: string[] };
    expect(self).toMatchObject({ scopes: ["robots:read", "sessions:readonly"], robots: [b.robotId] });
    // The activity page says it was the app.
    expect(await (await getPage(`/delegations/${dl.id}`, user)).text()).toContain("you, in the app");

    // Previewing again shows what it has now and the robot it may see.
    const again = (await (await signed("POST", CONSENT, { step: "preview", ...(await link(user, dl, ["robots:read"])) })).json()) as Record<string, any>;
    expect(again.existing).toMatchObject({ active: true, scopes: ["robots:read", "sessions:readonly"], notice: expect.stringContaining("This key already has access") });
    expect(again.robots.map((r: { robotId: string; ticked: boolean }) => [r.robotId, r.ticked])).toEqual([[a.robotId, false], [b.robotId, true]]);
  });

  it("refuses what the page refuses, and stores nothing", async () => {
    const user = await newUser();
    const stranger = await newUser();
    const { robot: theirs } = await registerAndClaim(stranger);
    const signed = await appDevice(user);
    const dl = await newDelegate();
    const other = await newDelegate();
    const l = await link(user, dl, ["robots:read"]);
    const approveWith = async (over: Record<string, unknown>, ln: { key: string; req: string } = l) =>
      signed("POST", CONSENT, { step: "approve", ...ln, scopes: ["robots:read"], robots: [], ttl: 86400, confirm: true, ...over });
    const refused = async (res: Response, status: number, error: string) => {
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error, message: expect.any(String) });
    };
    await refused(await approveWith({ confirm: false }), 400, "confirm_required");
    await refused(await approveWith({ scopes: ["robots:read", "robots:manage"] }), 400, "bad_request"); // not requested
    await refused(await approveWith({ scopes: ["sessions:owner"] }), 400, "bad_request");
    await refused(await approveWith({ scopes: [] }), 400, "no_scopes");
    await refused(await approveWith({ robots: [theirs.robotId] }), 409, "robot_not_yours");
    await refused(await approveWith({ ttl: 99 * 86400 }), 400, "bad_ttl");
    await refused(await approveWith({}, await link(stranger, dl, ["robots:read"])), 400, "wrong_account");
    await refused(await approveWith({}, await link(user, dl, ["robots:read"], { claims: { iat: nowSeconds() - 3600, exp: nowSeconds() - 1800 } })), 400, "link_expired");
    await refused(await approveWith({}, { key: l.key, req: (await link(user, other, ["robots:read"])).req }), 400, "invalid_link"); // another key's request
    await refused(await approveWith({}, await link(user, dl, ["robots:read", "robots:drive"])), 400, "invalid_link");
    for (const bad of [{ confirm: "yes" }, { ttl: "86400" }, { scopes: "robots:read" }, { robots: [1] }, { step: "allow" }, { key: 1 }]) {
      expect((await approveWith(bad)).status).toBe(400);
    }
    expect((await signed("POST", CONSENT, "{")).status).toBe(400);
    expect((await signed("POST", CONSENT, { step: "approve", ...l, scopes: ["robots:read"], robots: [], ttl: 86400, confirm: true, pad: "x".repeat(9000) })).status).toBe(400);
    expect(await (await signed("POST", CONSENT, { step: "decline", ...l })).json()).toEqual({ approved: false });
    expect((await signed("GET", CONSENT)).status).toBe(405);
    expect(await rows(dl.id)).toEqual({ delegations: 0, events: 0 });
  });

  it("never approves a revoked key, or another person's key, again", async () => {
    const { user, dl } = await delegated(["robots:read"]);
    const signed = await appDevice(user);
    expect((await signed("POST", `/v1/app/delegations/${dl.id}/revoke`)).status).toBe(200);
    for (const step of ["preview", "approve"]) {
      const res = await signed("POST", CONSENT, { step, ...(await link(user, dl, ["robots:read"])), scopes: ["robots:read"], robots: [], ttl: 86400, confirm: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "key_revoked", revokedAt: expect.any(Number) });
    }
    const other = await newUser();
    const theirs = await delegated(["robots:read"]);
    const otherSigned = await appDevice(other);
    for (const step of ["preview", "approve"]) {
      const res = await otherSigned("POST", CONSENT, { step, ...(await link(other, theirs.dl, ["robots:read"])), scopes: ["robots:read"], robots: [], ttl: 86400, confirm: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "key_other_account" });
    }
  });

  it(`keeps to ${MAX_ACTIVE_DELEGATIONS} active delegations and ${APPROVALS_PER_HOUR} approvals an hour`, async () => {
    const user = await newUser();
    const signed = await appDevice(user);
    const approveNew = async (dl: Delegate) => signed("POST", CONSENT, { step: "approve", ...(await link(user, dl, ["robots:read"])), scopes: ["robots:read"], robots: [], ttl: 3600, confirm: true });
    const first = await newDelegate();
    for (let i = 0; i < MAX_ACTIVE_DELEGATIONS; i++) expect((await approveNew(i === 0 ? first : await newDelegate())).status).toBe(200);
    const extra = await newDelegate();
    const prev = await signed("POST", CONSENT, { step: "preview", ...(await link(user, extra, ["robots:read"])) });
    expect([prev.status, ((await prev.json()) as { error: string }).error]).toEqual([403, "too_many_agents"]);
    expect([(await approveNew(extra)).status]).toEqual([403]);
    // Approving one of them again works, until the hourly approvals are used up (the page counts too).
    for (let i = MAX_ACTIVE_DELEGATIONS; i < APPROVALS_PER_HOUR; i++) expect((await approveNew(first)).status).toBe(200);
    const limited = await approveNew(first);
    expect([limited.status, ((await limited.json()) as { error: string }).error]).toEqual([429, "rate_limited"]);
    expect((await postForm("/delegate/authorize", user, await approvalForm(user, first, ["robots:read"]))).status).toBe(429);
  });

  it("is only for the people DELEGATION_USERS names, and stops under the emergency stop", async () => {
    const user = await newUser();
    const signed = await appDevice(user);
    const dl = await newDelegate();
    const body = { step: "preview", ...(await link(user, dl, ["robots:read"])) };
    expect((await signed("POST", CONSENT, body, { ...appEnv, DELEGATION_USERS: "" })).status).toBe(404);
    expect((await signed("POST", CONSENT, body, { ...appEnv, DELEGATION_USERS: "gh:1" })).status).toBe(404);
    expect((await signed("POST", CONSENT, body, { ...appEnv, DELEGATION_USERS: user.id })).status).toBe(200);
    await db.prepare("INSERT INTO settings (key, value) VALUES ('kill_switch', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    try {
      for (const step of ["preview", "approve"]) {
        const res = await signed("POST", CONSENT, { ...body, step, scopes: ["robots:read"], robots: [], ttl: 3600, confirm: true });
        expect([res.status, await res.json()]).toEqual([503, { error: "paused" }]);
      }
    } finally {
      await db.prepare("DELETE FROM settings WHERE key = 'kill_switch'").run();
    }
    expect(await rows(dl.id)).toEqual({ delegations: 0, events: 0 });
  });

  it("needs a signed call that works once", async () => {
    const user = await newUser();
    const signed = await appDevice(user);
    const dl = await newDelegate();
    const body = { step: "approve", ...(await link(user, dl, ["robots:read"])), scopes: ["robots:read"], robots: [], ttl: 3600, confirm: true };
    expect((await call(CONSENT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, appEnv)).status).toBe(401);
    const once = await signed.sign("POST", CONSENT);
    expect((await signed("POST", CONSENT, body, appEnv, once)).status).toBe(200);
    const before = await rows(dl.id);
    const replay = await signed("POST", CONSENT, { ...body, ttl: 2592000 }, appEnv, once);
    expect([replay.status, await replay.json()]).toEqual([401, { error: "invalid_assertion", detail: "replayed_jti" }]);
    expect(await rows(dl.id)).toEqual(before);
    expect((await db.prepare("SELECT ttl_seconds FROM delegations WHERE delegation_id = ?").bind(dl.id).first())).toEqual({ ttl_seconds: 3600 });
  });

  it("a refused approval changes nothing, even in the same second as an earlier one (final review)", async () => {
    const user = await newUser();
    const { robot: a } = await registerAndClaim(user, "A");
    const { robot: b } = await registerAndClaim(user, "B");
    const signed = await appDevice(user);
    const dl = await newDelegate();
    const at = nowSeconds();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at * 1000);
    try {
      const approveWith = async (robots: string[]) =>
        signed("POST", CONSENT, { step: "approve", ...(await link(user, dl, ["robots:read"])), scopes: ["robots:read"], robots, ttl: 3600, confirm: true });
      expect((await approveWith([a.robotId])).status).toBe(200);
      // The rest of the hour's approvals, in the same second.
      for (let i = 1; i < APPROVALS_PER_HOUR; i++) {
        await db.prepare("INSERT INTO delegation_events (delegation_id, at, actor, action, outcome) VALUES (?, ?, 'app', 'approve', 'ok')").bind(dl.id, at).run();
      }
      const before = await rows(dl.id);
      const limited = await approveWith([b.robotId]);
      expect([limited.status, ((await limited.json()) as { error: string }).error]).toEqual([429, "rate_limited"]);
      expect(await rows(dl.id)).toEqual(before);
      const set = await db.prepare("SELECT robot_id FROM delegation_robots WHERE delegation_id = ?").bind(dl.id).all<{ robot_id: string }>();
      expect(set.results.map((r) => r.robot_id)).toEqual([a.robotId]);
    } finally {
      clock.mockRestore();
    }
  });

  it("an approval does not complete when its device is signed out meanwhile (final review)", async () => {
    const user = await newUser();
    const signed = await appDevice(user);
    const dl = await newDelegate();
    // The device is signed out after it was verified and the link was checked, before the batch.
    const DB = pauseAt(
      (sql) => sql.includes("SELECT r.robot_id, r.name, m.label, m.role, r.simulator"),
      async () => void (await db.prepare("DELETE FROM devices WHERE device_id = ?").bind(signed.deviceId).run()),
    );
    const res = await signed("POST", CONSENT, { step: "approve", ...(await link(user, dl, ["robots:read"])), scopes: ["robots:read"], robots: [], ttl: 3600, confirm: true }, { ...appEnv, DB });
    expect([res.status, await res.json()]).toEqual([401, { error: "invalid_assertion", detail: "unknown_device" }]);
    expect(await rows(dl.id)).toEqual({ delegations: 0, events: 0 });
  });

  it("lists the consent link in apple-app-site-association only with delegation on", async () => {
    const paths = async (e: Env) =>
      ((await (await call("/.well-known/apple-app-site-association", {}, e)).json()) as { applinks: { details: { components: { "/": string }[] }[] } }).applinks.details[0]!.components.map((c) => c["/"]);
    expect(await paths(appEnv)).toEqual(["/app/callback", "/delegate/authorize"]);
    expect(await paths({ ...appEnv, DELEGATION_USERS: "" })).toEqual(["/app/callback"]);
  });
});

/** The database, but `before` runs once just before the first statement whose SQL matches. */
function pauseAt(match: (sql: string) => boolean, before: () => Promise<void>): D1Database {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const st = target.prepare(sql);
          if (fired || !match(sql)) return st;
          fired = true;
          return {
            bind: (...args: unknown[]) => ({
              first: async () => (await before(), st.bind(...args).first()),
              run: async () => (await before(), st.bind(...args).run()),
              all: async () => (await before(), st.bind(...args).all()),
            }),
          };
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as D1Database;
}

/** Unlinks the robot and lets `who` add it again with a fresh pairing code. */
async function unlinkAndReclaim(robot: TestRobot, who: TestUser): Promise<void> {
  expect(await unlinkRobot(env, createProvisioner(env), robot.robotId)).toBe(true);
  const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
  expect((await postForm("/claim", who, new URLSearchParams({ code: pairingCode }))).status).toBe(303);
}

describe("security review 14", () => {
  it("an unlink authorized before the robot was unlinked and added again by someone else does nothing", async () => {
    const { dl, owned } = await delegated(["robots:manage"], 1);
    const robot = owned[0]!;
    const other = await newUser();
    let fired = false;
    const DB = pauseAt(
      (sql) => sql.includes("INSERT INTO delegation_events") && sql.includes("RETURNING id"),
      async () => {
        fired = true;
        await unlinkAndReclaim(robot, other);
      },
    );
    const res = await api(dl, "POST", `/v1/delegate/robots/${robot.robotId}/unlink`, {}, { ...env, DB });
    expect(fired).toBe(true);
    expect(res.status).toBe(404);
    expect(await db.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robot.robotId).first()).toEqual({ status: "claimed" });
    expect(await db.prepare("SELECT user_id, role FROM members WHERE robot_id = ?").bind(robot.robotId).first()).toEqual({ user_id: other.id, role: "owner" });
  });

  it("a claim that finishes after its robot was unlinked and added again by hand does not bring it back to the agent", async () => {
    const { user, dl } = await delegated(["robots:claim", "robots:read"]);
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    let fired = false;
    const DB = pauseAt(
      (sql) => sql.startsWith("UPDATE delegation_events SET outcome"),
      async () => {
        fired = true;
        await unlinkAndReclaim(robot, user);
      },
    );
    expect((await api(dl, "POST", "/v1/delegate/claim", { code: pairingCode, step: "confirm" }, { ...env, DB })).status).toBe(200);
    expect(fired).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM delegation_robots WHERE delegation_id = ?").bind(dl.id).first()).toEqual({ n: 0 });
  });

  it("over the call limit, calls write nothing, not even a replay record; revoking itself still works", async () => {
    const { dl } = await delegated(["robots:read"]);
    const now = nowSeconds();
    await db.batch(
      Array.from({ length: CALLS_PER_HOUR }, () =>
        db.prepare("INSERT INTO delegation_events (delegation_id, at, actor, action, outcome) VALUES (?, ?, 'agent', 'list', 'ok')").bind(dl.id, now - 60),
      ),
    );
    for (let i = 0; i < 5; i++) expect((await api(dl, "GET", "/v1/delegate/self")).status).toBe(429);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM jti_seen WHERE robot_id = ?").bind(`dlg:${dl.id}`).first()).toEqual({ n: 0 });
    expect((await api(dl, "POST", "/v1/delegate/revoke", {})).status).toBe(200);
  });

  it("every authenticated call counts, malformed ones included", async () => {
    const { dl, owned } = await delegated(["robots:manage", "robots:claim"], 1);
    const path = `/v1/delegate/robots/${owned[0]!.robotId}/label`;
    const bad = "{not json";
    const res = await call(path, { method: "POST", headers: { Authorization: await sign(dl, "POST", path, bad), "Content-Type": "application/json" }, body: bad }, env);
    expect(res.status).toBe(400);
    expect((await api(dl, "POST", "/v1/delegate/claim", { step: "confirm" })).status).toBe(400);
    expect((await api(dl, "POST", "/v1/delegate/robots/NOT-A-ROBOT/grant", {})).status).toBe(404);
    const outcomes = (await events(dl.id)).filter((e) => e.actor === "agent").map((e) => `${e.action}:${e.outcome}`);
    expect(outcomes).toEqual(["label:bad_request", "claim:bad_request", "grant:not_found"]);
  });

  it("only the account the agent named can approve its key, and nobody can change the request", async () => {
    const alice = await newUser();
    const mallory = await newUser();
    const dl = await newDelegate();
    // Mallory opens Alice's link before Alice does.
    const page = await getPage(`/delegate/authorize?${await consentQuery(alice, dl, ["robots:claim"])}`, mallory);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("Only that account can approve it");
    expect((await postForm("/delegate/authorize", mallory, await approvalForm(alice, dl, ["robots:claim"]))).status).toBe(400);
    // Nor can she rewrite the link for herself, or widen it, without the key.
    const stranger = await newDelegate();
    expect((await getPage(`/delegate/authorize?${await consentQuery(mallory, dl, ["robots:claim"], { signWith: stranger.key })}`, mallory)).status).toBe(400);
    const q = await consentQuery(alice, dl, ["robots:read"]);
    const [h, , sig] = q.get("req")!.split(".");
    const widened = b64urlEncode(new TextEncoder().encode(JSON.stringify({ ...decodeJws(q.get("req")!).payload, scopes: "robots:read robots:manage" })));
    q.set("req", `${h}.${widened}.${sig}`);
    expect((await getPage(`/delegate/authorize?${q}`, alice)).status).toBe(400);
    for (const claims of [{ aud: "https://other.test" }, { iss: stranger.id }, { iat: nowSeconds() - 4000, exp: nowSeconds() - 2200 }, { exp: nowSeconds() + 7200 }]) {
      expect((await getPage(`/delegate/authorize?${await consentQuery(alice, dl, ["robots:read"], { claims })}`, alice)).status).toBe(400);
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM delegations WHERE delegation_id = ?").bind(dl.id).first<{ n: number }>())!.n).toBe(0);
    await approve(alice, dl, ["robots:claim"]);
    expect(await (await api(dl, "GET", "/v1/delegate/self")).json()).toMatchObject({ login: await loginOf(alice) });
  });

  it("caps read-only grants per robot, so a delegate cannot fill the robot's session table", async () => {
    const { dl, owned } = await delegated(["sessions:readonly"], 2);
    for (let i = 0; i < GRANTS_PER_ROBOT_PER_HOUR; i++) {
      expect((await api(dl, "POST", `/v1/delegate/robots/${owned[0]!.robotId}/grant`, {})).status).toBe(200);
    }
    const res = await api(dl, "POST", `/v1/delegate/robots/${owned[0]!.robotId}/grant`, {});
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "grant_limit" });
    expect((await api(dl, "POST", `/v1/delegate/robots/${owned[1]!.robotId}/grant`, {})).status).toBe(200);
  });

  it("a claim does not complete when the delegation is revoked while the robot is being added", async () => {
    const { user, dl } = await delegated(["robots:claim"]);
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const DB = pauseAt(
      (sql) => sql.startsWith("SELECT status, name, hostname FROM robots"),
      async () => {
        await postForm(`/delegations/${dl.id}/revoke`, user, new URLSearchParams());
      },
    );
    const res = await api(dl, "POST", "/v1/delegate/claim", { code: pairingCode, step: "confirm" }, { ...env, DB });
    expect(res.status).toBe(403);
    expect(await db.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robot.robotId).first()).toEqual({ status: "unclaimed" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM delegation_robots WHERE delegation_id = ?").bind(dl.id).first()).toEqual({ n: 0 });
    // The code still works for the person.
    expect((await postForm("/claim", user, new URLSearchParams({ code: pairingCode }))).status).toBe(303);
  });

  it("the body hash covers the exact bytes: a BOM or invalid UTF-8 does not pass", async () => {
    const { dl, owned } = await delegated(["robots:manage"], 1);
    const path = `/v1/delegate/robots/${owned[0]!.robotId}/label`;
    const body = JSON.stringify({ label: "probe" });
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body)]);
    const r1 = await call(path, { method: "POST", headers: { Authorization: await sign(dl, "POST", path, body), "Content-Type": "application/json" }, body: withBom }, env);
    expect(await r1.json()).toMatchObject({ detail: "bad_bdh" });
    const invalid = new Uint8Array([...new TextEncoder().encode('{"label":"'), 0xff, ...new TextEncoder().encode('"}')]);
    const r2 = await call(path, { method: "POST", headers: { Authorization: await sign(dl, "POST", path, '{"label":"\ufffd"}'), "Content-Type": "application/json" }, body: invalid }, env);
    expect(await r2.json()).toMatchObject({ detail: "bad_bdh" });
    // Signed over those exact bytes, the signature is fine but the body is not UTF-8: refused.
    const auth = await signBytes(dl, "POST", path, invalid);
    const r3 = await call(path, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: invalid }, env);
    expect(r3.status).toBe(400);
  });
});

describe("final security review", () => {
  const replayRecords = (id: string) =>
    db.prepare("SELECT COUNT(*) AS n FROM jti_seen WHERE robot_id = ?").bind(`dlg:${id}`).first<{ n: number }>().then((r) => r!.n);

  it("refusals by a per-action cap use up the call limit, so a key cannot write more than the limit", async () => {
    const { dl, owned } = await delegated(["sessions:readonly"], 1);
    const path = `/v1/delegate/robots/${owned[0]!.robotId}/grant`;
    let last: Response | null = null;
    for (let i = 0; i < CALLS_PER_HOUR + 5; i++) last = await api(dl, "POST", path, {});
    expect(last!.status).toBe(429);
    expect(await last!.json()).toEqual({ error: "rate_limited" });
    expect((await events(dl.id)).filter((e) => e.actor === "agent").length).toBe(CALLS_PER_HOUR);
    expect(await replayRecords(dl.id)).toBe(CALLS_PER_HOUR);
  });

  it("a person who lost access writes nothing", async () => {
    const { user, dl } = await delegated(["robots:read"]);
    const e = { ...env, DELEGATION_USERS: "gh:1" };
    for (let i = 0; i < 3; i++) expect((await api(dl, "GET", "/v1/delegate/self", undefined, e)).status).toBe(403);
    expect(await replayRecords(dl.id)).toBe(0);
    expect(user.id).not.toBe("gh:1");
  });

  it("the consent link is bound to the account id, not its login, which GitHub hands on", async () => {
    const alice = await newUser();
    const mallory = await newUser();
    const dl = await newDelegate();
    // Mallory now has the login Alice's link names.
    const q = await consentQuery(alice, dl, ["robots:claim"], { claims: { account: await loginOf(mallory) } });
    const page = await getPage(`/delegate/authorize?${q}`, mallory);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain(alice.id);
    const noUid = await consentQuery(mallory, dl, ["robots:claim"], { claims: { uid: undefined } });
    expect((await getPage(`/delegate/authorize?${noUid}`, mallory)).status).toBe(400);
    await approve(alice, dl, ["robots:claim"]);
    expect(await (await api(dl, "GET", "/v1/delegate/self")).json()).toMatchObject({ userId: alice.id });
  });

  it("a claim does not complete when the delegation expires while the robot is being added", async () => {
    const { dl } = await delegated(["robots:claim"]);
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const DB = pauseAt(
        (sql) => sql.startsWith("SELECT status, name, hostname FROM robots"),
        async () => {
          vi.setSystemTime(Date.now() + 86400 * 1000 + 5000); // past the 24 hours it was approved for
        },
      );
      const res = await api(dl, "POST", "/v1/delegate/claim", { code: pairingCode, step: "confirm" }, { ...env, DB });
      expect(res.status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
    expect(await db.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robot.robotId).first()).toEqual({ status: "unclaimed" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM delegation_robots WHERE delegation_id = ?").bind(dl.id).first()).toEqual({ n: 0 });
  });

  it("a label waiting while its delegation loses robots:manage is not written", async () => {
    const { user, dl, owned } = await delegated(["robots:manage", "robots:read"], 1);
    const robotId = owned[0]!.robotId;
    const DB = pauseAt(
      (sql) => sql.startsWith("UPDATE members SET label"),
      async () => {
        await approve(user, dl, ["robots:read"], [robotId]);
      },
    );
    const res = await api(dl, "POST", `/v1/delegate/robots/${robotId}/label`, { label: "Renamed" }, { ...env, DB });
    expect(res.status).toBe(404);
    expect(await db.prepare("SELECT label FROM members WHERE robot_id = ? AND user_id = ?").bind(robotId, user.id).first()).not.toEqual({ label: "Renamed" });
  });
});

async function signBytes(dl: Delegate, method: string, path: string, body: Uint8Array): Promise<string> {
  const now = nowSeconds();
  const claims = { iss: dl.id, aud: ORIGIN, htm: method, htu: `${ORIGIN}${path}`, bdh: await bodyHash(body), iat: now, exp: now + 60, jti: randomToken(16) };
  return `MC-Delegate ${await signJws({ alg: "EdDSA", typ: "mc-delegate+jwt" }, claims, dl.key)}`;
}

describe("delegations under the emergency stop", () => {
  it("get no grant and no read, the robot lists no delegates, and revoking still works", async () => {
    const { dl, owned } = await delegated(ALL, 1);
    const robot = owned[0]!;
    expect((await api(dl, "POST", `/v1/delegate/robots/${robot.robotId}/grant`, {})).status).toBe(200);
    expect((await members(robot)).some((m) => m.userId.startsWith("dlg:"))).toBe(true);

    await db.prepare("INSERT INTO settings (key, value) VALUES ('kill_switch', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    try {
      for (const [method, path, body] of [["POST", `/v1/delegate/robots/${robot.robotId}/grant`, {}], ["GET", "/v1/delegate/self", undefined], ["GET", "/v1/delegate/robots", undefined]] as const) {
        const res = await api(dl, method, path, body);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "paused" });
      }
      expect(await members(robot)).toEqual([]);
      expect((await api(dl, "POST", "/v1/delegate/revoke", {})).status).toBe(200);
    } finally {
      await db.prepare("DELETE FROM settings WHERE key = 'kill_switch'").run();
    }
  });
});
