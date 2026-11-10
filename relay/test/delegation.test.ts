import { describe, expect, it } from "vitest";
import { b64urlEncode, deriveRobotId, signJws } from "../src/crypto";
import { bodyHash, fingerprint } from "../src/delegateAuth";
import { CALLS_PER_HOUR, MAX_ACTIVE_DELEGATIONS, MAX_CLAIMED_ROBOTS, WRONG_CODES_PER_HOUR } from "../src/delegation";
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

function consentQuery(dl: Delegate, scopes: string[], o: { name?: string; ttl?: number } = {}): URLSearchParams {
  return new URLSearchParams({ key: dl.publicKey, name: o.name ?? "Test agent", scopes: scopes.join(" "), ttl: String(o.ttl ?? 86400) });
}

function getPage(path: string, user: TestUser | null, e: Env = env): Promise<Response> {
  return call(path, { headers: user ? { Cookie: user.cookie } : {}, redirect: "manual" }, e);
}

function postForm(path: string, user: TestUser, form: URLSearchParams, origin: string | null = ORIGIN, e: Env = env): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Cookie: user.cookie };
  if (origin) headers.Origin = origin;
  return call(path, { method: "POST", headers, body: form.toString(), redirect: "manual" }, e);
}

function approvalForm(dl: Delegate, scopes: string[], robots: string[] = [], o: { ttl?: number; requested?: string[]; confirm?: boolean; name?: string } = {}): URLSearchParams {
  const f = consentQuery(dl, o.requested ?? scopes, { ttl: o.ttl, name: o.name });
  for (const s of scopes) f.append("scope", s);
  for (const r of robots) f.append("robot", r);
  if (o.confirm !== false) f.set("confirm", "yes");
  f.set("decision", "allow");
  return f;
}

/** Runs the consent page and approves it. */
async function approve(user: TestUser, dl: Delegate, scopes: string[], robots: string[] = [], o: { ttl?: number; name?: string } = {}): Promise<void> {
  const page = await getPage(`/delegate/authorize?${consentQuery(dl, scopes, o)}`, user);
  expect(page.status).toBe(200);
  const res = await postForm("/delegate/authorize", user, approvalForm(dl, scopes, robots, o));
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
    expect((await getPage(`/delegate/authorize?${consentQuery(dl, ["robots:read"])}`, user, testEnv)).status).toBe(404);
    expect(await (await getPage("/", user, testEnv)).text()).not.toContain("AI agents");
  });

  it("is only for the people DELEGATION_USERS names", async () => {
    const user = await newUser();
    const other = await newUser();
    const e = { ...env, DELEGATION_USERS: ` ${user.id.toUpperCase()} ` };
    const dl = await newDelegate();
    expect((await getPage(`/delegate/authorize?${consentQuery(dl, ["robots:read"])}`, other, e)).status).toBe(404);
    expect(await (await getPage("/", other, e)).text()).not.toContain("AI agents");
    expect(await (await getPage("/", user, e)).text()).toContain("AI agents");
    expect((await getPage(`/delegate/authorize?${consentQuery(dl, ["robots:read"])}`, user, e)).status).toBe(200);
  });
});

describe("consent", () => {
  it("shows the agent, the fingerprint, the scopes and the robots, and writes nothing", async () => {
    const user = await newUser();
    const { robot } = await registerAndClaim(user, "Front Lawn");
    const dl = await newDelegate();
    const res = await getPage(`/delegate/authorize?${consentQuery(dl, ["robots:read", "sessions:readonly"], { name: "Claude <b>laptop</b>" })}`, user);
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

  it("sends a signed-out person through sign-in", async () => {
    const dl = await newDelegate();
    const res = await getPage(`/delegate/authorize?${consentQuery(dl, ["robots:read"])}`, null);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/login\?return_to=%2Fdelegate%2Fauthorize/);
  });

  it("refuses rights that do not exist, and bad links", async () => {
    const user = await newUser();
    const dl = await newDelegate();
    for (const scopes of [["robots:read", "robots:drive"], ["sessions:owner"], ["admin"], []]) {
      expect((await getPage(`/delegate/authorize?${consentQuery(dl, scopes)}`, user)).status).toBe(400);
    }
    expect((await getPage(`/delegate/authorize?key=abc&name=x&scopes=robots:read`, user)).status).toBe(400);
    expect((await getPage(`/delegate/authorize?key=${dl.publicKey}&scopes=robots:read`, user)).status).toBe(400);
  });

  it("needs our Origin, the confirmation box and only requested scopes and own robots", async () => {
    const user = await newUser();
    const stranger = await newUser();
    const { robot: theirs } = await registerAndClaim(stranger);
    const dl = await newDelegate();
    const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM delegations WHERE delegation_id = ?").bind(dl.id).first<{ n: number }>())!.n;
    expect((await postForm("/delegate/authorize", user, approvalForm(dl, ["robots:read"]), "https://evil.test")).status).toBe(403);
    expect((await postForm("/delegate/authorize", user, approvalForm(dl, ["robots:read"]), null)).status).toBe(403);
    expect((await postForm("/delegate/authorize", user, approvalForm(dl, ["robots:read"], [], { confirm: false }))).status).toBe(400);
    expect((await postForm("/delegate/authorize", user, approvalForm(dl, ["robots:read", "robots:manage"], [], { requested: ["robots:read"] }))).status).toBe(400);
    expect((await postForm("/delegate/authorize", user, approvalForm(dl, ["robots:read"], [theirs.robotId]))).status).toBe(409);
    expect((await postForm("/delegate/authorize", user, approvalForm(dl, ["robots:read"], [], { ttl: 99 * 86400 }))).status).toBe(400);
    const deny = approvalForm(dl, ["robots:read"]);
    deny.set("decision", "deny");
    expect(await (await postForm("/delegate/authorize", user, deny)).text()).toContain("Nothing was changed");
    expect(await count()).toBe(0);
  });

  it("snaps a requested duration down to an offered one", async () => {
    const user = await newUser();
    const dl = await newDelegate();
    const text = await (await getPage(`/delegate/authorize?${consentQuery(dl, ["robots:read"], { ttl: 2 * 86400 })}`, user)).text();
    expect(text).toContain('<option value="86400" selected>');
  });

  it("a key belongs to one person", async () => {
    const { dl } = await delegated(["robots:read"]);
    const other = await newUser();
    expect((await getPage(`/delegate/authorize?${consentQuery(dl, ["robots:read"])}`, other)).status).toBe(409);
    expect((await postForm("/delegate/authorize", other, approvalForm(dl, ["robots:read"]))).status).toBe(409);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM delegations WHERE user_id = ?").bind(other.id).first<{ n: number }>())!.n).toBe(0);
  });

  it(`allows at most ${MAX_ACTIVE_DELEGATIONS} active delegations per person`, async () => {
    const user = await newUser();
    for (let i = 0; i < MAX_ACTIVE_DELEGATIONS; i++) await approve(user, await newDelegate(), ["robots:read"]);
    const extra = await newDelegate();
    expect((await postForm("/delegate/authorize", user, approvalForm(extra, ["robots:read"]))).status).toBe(403);
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

  it("an unknown or wrongly signed key writes nothing", async () => {
    const dl = await newDelegate();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM jti_seen").first<{ n: number }>();
    const res = await api(dl, "GET", "/v1/delegate/self");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ detail: "unknown_delegate" });
    const { dl: real } = await delegated(["robots:read"]);
    const forged = await call("/v1/delegate/self", { headers: { Authorization: await sign(dl, "GET", "/v1/delegate/self", "", { iss: real.id }) } }, env);
    expect(await forged.json()).toMatchObject({ detail: "bad_signature" });
    expect(await events(real.id)).toEqual([expect.objectContaining({ actor: "person", action: "approve" })]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM jti_seen").first<{ n: number }>())!.n).toBe(before!.n);
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
    expect(list.robots).toEqual([expect.objectContaining({ robotId: ticked.robotId, addedByDelegate: false, role: "owner" })]);
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
    // A revoked delegation cannot be renewed, only approved again.
    expect((await postForm(`/delegations/${dl.id}/renew`, user, new URLSearchParams())).status).toBe(404);
    await approve(user, dl, ["robots:read"]);
    expect((await api(dl, "GET", "/v1/delegate/self")).status).toBe(200);
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

describe("the app can list and revoke delegations", () => {
  const APP_ID = "ABCDE12345.garden.mowgli.app";
  const appEnv: Env = { ...env, APP_IOS_APP_IDS: APP_ID };
  const enc = new TextEncoder();

  it("lists them and revokes one, signed by the device", async () => {
    const { user, dl } = await delegated(["robots:read"]);
    // A device for this person, inserted directly (the sign-in flow is covered in app.test.ts).
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const j = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    const jwk = { kty: "EC", crv: "P-256", x: j.x!, y: j.y! };
    const tp = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`))));
    await db.prepare("INSERT INTO devices (device_id, user_id, name, public_jwk, created_at, last_used_at) VALUES (?, ?, 'Phone', ?, ?, ?)")
      .bind(tp, user.id, JSON.stringify(jwk), nowSeconds(), nowSeconds())
      .run();
    const signed = async (method: string, path: string) => {
      const now = nowSeconds();
      const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", typ: "mc-device+jwt" })));
      const p = b64urlEncode(enc.encode(JSON.stringify({ iss: tp, aud: ORIGIN, htm: method, htu: `${ORIGIN}${path}`, iat: now, exp: now + 60, jti: randomToken(16) })));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, enc.encode(`${h}.${p}`)));
      return call(path, { method, headers: { Authorization: `MC-Device ${h}.${p}.${b64urlEncode(sig)}` } }, appEnv);
    };
    expect(await (await signed("GET", "/v1/app/delegations")).json()).toEqual({
      delegations: [expect.objectContaining({ delegateId: dl.id, name: "Test agent", scopes: ["robots:read"], revokedAt: null })],
    });
    expect(await (await signed("POST", `/v1/app/delegations/${dl.id}/revoke`)).json()).toEqual({ ok: true });
    expect((await signed("POST", `/v1/app/delegations/${dl.id}/revoke`)).status).toBe(404);
    expect((await events(dl.id)).at(-1)).toMatchObject({ actor: "app", action: "revoke" });
    expect((await api(dl, "GET", "/v1/delegate/self")).status).toBe(401);
  });
});
