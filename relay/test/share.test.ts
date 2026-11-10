import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { LOOKUPS_PER_HOUR, LOOKUPS_PER_PERSON_PER_HOUR, MAX_SHARES_PER_ROBOT, SHARES_PER_OWNER_PER_HOUR } from "../src/share";
import { nowSeconds } from "../src/util";
import { assertion, call, decodeJws, newRobot, newUser, ORIGIN, register, testEnv, type TestRobot, type TestUser } from "./helpers";

// Nobody may sign in by configuration here: owners are invited, everyone else is a guest or nobody.
const env: Env = { ...testEnv, ALLOWED_GITHUB_LOGINS: "" };

interface GhProfile {
  id: number;
  login: string;
  name?: string | null;
  type?: string;
}

/**
 * Fakes GitHub: account lookups (/users/<login>, /user/<id>) from `accounts`, and OAuth sign-in
 * as `signingIn.profile`. Returns the lookup URLs called.
 */
let accounts: GhProfile[] = [];
const signingIn: { profile: GhProfile | null } = { profile: null };
let lookups: string[] = [];
beforeEach(() => {
  accounts = [];
  lookups = [];
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_fake" });
    if (url === "https://api.github.com/user") return Response.json(signingIn.profile);
    const byLogin = /^https:\/\/api\.github\.com\/users\/([^/]+)$/.exec(url);
    const byId = /^https:\/\/api\.github\.com\/user\/(\d+)$/.exec(url);
    if (!byLogin && !byId) return new Response("unexpected", { status: 500 });
    lookups.push(url);
    const p = accounts.find((x) => (byLogin ? x.login.toLowerCase() === decodeURIComponent(byLogin[1]!).toLowerCase() : String(x.id) === byId![1]));
    if (!p) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return Response.json({ type: "User", name: null, created_at: "2016-02-01T00:00:00Z", ...p });
  });
});
afterEach(() => vi.unstubAllGlobals());

let idCounter = 60000;
function nextId(): number {
  return ++idCounter * 10 + Math.floor(Math.random() * 10);
}

function get(path: string, user: TestUser | null, e: Env = env) {
  return call(path, { headers: user ? { Cookie: user.cookie } : {}, redirect: "manual" }, e);
}

function post(path: string, user: TestUser | null, form: Record<string, string>, headers: Record<string, string> = { Origin: ORIGIN }, e: Env = env) {
  return call(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers, ...(user ? { Cookie: user.cookie } : {}) },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    },
    e,
  );
}

/** Signs in through GitHub OAuth like a browser; null when the relay refuses the account. */
async function signIn(profile: GhProfile): Promise<TestUser | null> {
  signingIn.profile = profile;
  const start = await get("/login", null);
  const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
  const oauth = start.headers.getSetCookie().find((c) => c.startsWith("__Host-mcr_oauth="))!.split(";")[0]!;
  const done = await call(`/auth/github/callback?code=c-${Math.random()}&state=${state}`, { headers: { Cookie: oauth }, redirect: "manual" }, env);
  if (done.status !== 302) return null;
  const session = done.headers.getSetCookie().find((c) => c.startsWith("__Host-mcr_session="))!.split(";")[0]!;
  return { id: `gh:${profile.id}`, cookie: session };
}

/** An invited person (may own robots) with a session. */
async function invitedUser(login?: string): Promise<TestUser> {
  const u = await newUser(login);
  await testEnv.DB.prepare("INSERT INTO invites (user_id, login, robot_limit, invited_by, created_at) VALUES (?, ?, NULL, 'gh:1', ?)")
    .bind(u.id, login ?? u.id, nowSeconds())
    .run();
  return u;
}

async function ownedRobot(owner: TestUser, label?: string): Promise<TestRobot> {
  const robot = await newRobot();
  const reg = (await (await register(robot)).json()) as { pairingCode: string };
  const res = await post("/claim", owner, { code: reg.pairingCode, ...(label ? { label } : {}) });
  expect(res.status).toBe(303);
  return robot;
}

/** Shares through the two-step form and returns the shared account's user id. */
async function share(owner: TestUser, robot: TestRobot, gh: GhProfile, role: "viewer" | "operator" = "viewer"): Promise<string> {
  if (!accounts.some((a) => a.id === gh.id)) accounts.push(gh);
  const found = await post(`/robots/${robot.robotId}/share`, owner, { login: gh.login, role });
  expect(found.status).toBe(200);
  expect(await found.text()).toContain(`name="id" value="${gh.id}"`);
  const done = await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role });
  expect(done.status).toBe(303);
  expect(done.headers.get("Location")).toBe(`/robots/${robot.robotId}/share?notice=shared`);
  return `gh:${gh.id}`;
}

const member = (robotId: string, userId: string) =>
  testEnv.DB.prepare("SELECT role FROM members WHERE robot_id = ? AND user_id = ?").bind(robotId, userId).first<{ role: string }>();

async function selfMembers(robot: TestRobot): Promise<{ userId: string; role: string }[]> {
  const res = await call("/v1/robots/self", { headers: { Authorization: await assertion(robot, "GET", "/v1/robots/self") } }, env);
  return ((await res.json()) as { members: { userId: string; role: string }[] }).members;
}

function grantRole(res: Response): string {
  expect(res.status).toBe(302);
  return decodeJws(res.headers.get("Location")!.split("#grant=")[1]!).payload.role;
}

async function count(table: string, userId: string, column = "user_id"): Promise<number> {
  return (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(userId).first<{ n: number }>())!.n;
}

/** The owner's rows in the hourly share budget. */
async function shareRows(ownerId: string): Promise<number> {
  return (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM share_events WHERE user_id = ? AND kind = 'share'").bind(ownerId).first<{ n: number }>())!.n;
}

async function addDevice(userId: string): Promise<void> {
  await testEnv.DB.prepare("INSERT INTO devices (device_id, user_id, name, public_jwk, created_at, last_used_at) VALUES (?, ?, 'Phone', '{}', ?, ?)")
    .bind(crypto.randomUUID().replace(/-/g, "").padEnd(43, "x"), userId, nowSeconds(), nowSeconds())
    .run();
}

async function signedOut(user: TestUser): Promise<boolean> {
  return (await (await get("/", user)).text()).includes("Sign in with GitHub");
}

describe("sharing a robot", () => {
  it("shares by GitHub login, stores the id, and lets the guest sign in and open it with that role", async () => {
    const owner = await invitedUser("own-er");
    const robot = await ownedRobot(owner, "Front lawn");
    const gh = { id: nextId(), login: "Guest-One", name: "Guest One" };
    // Not invited: GitHub sign-in is refused before the share.
    expect(await signIn(gh)).toBeNull();

    accounts.push(gh);
    const page = await get(`/robots/${robot.robotId}/share`, owner);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Share Front lawn");
    const found = await post(`/robots/${robot.robotId}/share`, owner, { login: "https://github.com/guest-one", role: "operator" });
    const confirm = await found.text();
    expect(confirm).toContain("Share Front lawn with @Guest-One?");
    expect(confirm).toContain('name="role" value="operator"');
    expect(await member(robot.robotId, `gh:${gh.id}`)).toBeNull(); // nothing shared before confirming
    const done = await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role: "operator" });
    expect(done.status).toBe(303);
    expect(await member(robot.robotId, `gh:${gh.id}`)).toEqual({ role: "operator" });
    // The login and name are GitHub's; a row marks that they have not signed in yet.
    expect(await testEnv.DB.prepare("SELECT login, name, last_login_at FROM users WHERE id = ?").bind(`gh:${gh.id}`).first()).toEqual({
      login: "Guest-One",
      name: "Guest One",
      last_login_at: 0,
    });
    expect(await (await get(`/robots/${robot.robotId}/share`, owner)).text()).toContain("Not signed in yet");

    const guest = (await signIn(gh))!;
    expect(guest).not.toBeNull();
    const home = await (await get("/", guest)).text();
    expect(home).toContain("Robots shared with you");
    expect(home).toContain("Front lawn");
    expect(home).toContain("Shared with you by @own-er: Can control");
    expect(home).toContain(`action="/robots/${robot.robotId}/leave"`);
    expect(home).not.toContain('action="/claim"'); // no pairing form
    expect(home).not.toContain(robot.robotId + ".robots.test"); // no tunnel details
    expect(home).not.toContain("/share\"");
    expect(home).not.toContain("/unlink");
    expect(grantRole(await get(`/open/${robot.robotId}`, guest))).toBe("operator");
    expect(await selfMembers(robot)).toEqual([
      { userId: owner.id, role: "owner" },
      { userId: `gh:${gh.id}`, role: "operator" },
    ]);
    // Not an invitation: the admin page does not list them, and their robot limit is 0.
    expect(await testEnv.DB.prepare("SELECT 1 FROM invites WHERE user_id = ?").bind(guest.id).first()).toBeNull();
    const { robotLimit } = await import("../src/access");
    expect(await robotLimit(env, guest.id)).toBe(0);
  });

  it("binds the share to the GitHub id: a renamed or re-registered login gets nothing", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const alice = { id: nextId(), login: "alice-sh" };
    await share(owner, robot, alice);
    // Alice renames her account; somebody else registers her old login.
    expect(await signIn({ id: nextId(), login: "alice-sh" })).toBeNull();
    const renamed = (await signIn({ id: alice.id, login: "alice-renamed" }))!;
    expect(grantRole(await get(`/open/${robot.robotId}`, renamed))).toBe("viewer");
    // The owner sees the current login after she signs in.
    expect(await (await get(`/robots/${robot.robotId}/share`, owner)).text()).toContain("@alice-renamed");
  });

  it("changes the role, and the robot and new grants follow", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "role-change" };
    const target = await share(owner, robot, gh, "viewer");
    const guest = (await signIn(gh))!;
    expect(grantRole(await get(`/open/${robot.robotId}`, guest))).toBe("viewer");
    const res = await post(`/robots/${robot.robotId}/members/${target}/role`, owner, { role: "operator" });
    expect(res.status).toBe(303);
    expect(await member(robot.robotId, target)).toEqual({ role: "operator" });
    expect(grantRole(await get(`/open/${robot.robotId}`, guest))).toBe("operator");
    expect(await selfMembers(robot)).toContainEqual({ userId: target, role: "operator" });
    await post(`/robots/${robot.robotId}/members/${target}/role`, owner, { role: "viewer" });
    expect(await selfMembers(robot)).toContainEqual({ userId: target, role: "viewer" });
    // A role change does not sign everyone out (the robot caps sessions by the member list).
    const epoch = async () => (await testEnv.DB.prepare("SELECT session_epoch FROM robots WHERE robot_id = ?").bind(robot.robotId).first<{ session_epoch: number }>())!.session_epoch;
    const before = await epoch();
    await post(`/robots/${robot.robotId}/members/${target}/role`, owner, { role: "operator" });
    expect(await epoch()).toBe(before);
  });

  it("removing a guest's last share signs them out everywhere and drops them from the robot", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "removed-guest" };
    const target = await share(owner, robot, gh, "operator");
    const guest = (await signIn(gh))!;
    const browser2 = (await signIn(gh))!;
    await testEnv.DB.prepare("INSERT INTO devices (device_id, user_id, name, public_jwk, created_at, last_used_at) VALUES (?, ?, 'Phone', '{}', ?, ?)")
      .bind("d".repeat(43), target, nowSeconds(), nowSeconds())
      .run();
    const res = await post(`/robots/${robot.robotId}/members/${target}/remove`, owner, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/robots/${robot.robotId}/share?notice=removed`);
    expect(await member(robot.robotId, target)).toBeNull();
    expect(await signedOut(guest)).toBe(true);
    expect(await signedOut(browser2)).toBe(true);
    const count = async (table: string) => (await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(target).first<{ n: number }>())!.n;
    expect(await count("sessions")).toBe(0);
    expect(await count("devices")).toBe(0);
    expect((await get(`/open/${robot.robotId}`, guest)).headers.get("Location")).toMatch(/^\/login/);
    expect((await selfMembers(robot)).map((m) => m.userId)).toEqual([owner.id]);
    expect(await signIn(gh)).toBeNull();
  });

  it("a guest with another share stays signed in when one share ends", async () => {
    const a = await invitedUser();
    const b = await invitedUser();
    const ra = await ownedRobot(a);
    const rb = await ownedRobot(b);
    const gh = { id: nextId(), login: "two-shares" };
    const target = await share(a, ra, gh);
    await share(b, rb, gh);
    const guest = (await signIn(gh))!;
    await post(`/robots/${ra.robotId}/members/${target}/remove`, a, {});
    expect(await signedOut(guest)).toBe(false);
    expect((await get(`/open/${ra.robotId}`, guest)).status).toBe(404);
    expect(grantRole(await get(`/open/${rb.robotId}`, guest))).toBe("viewer");
  });

  it("removing someone who never signed in leaves no account row", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const target = await share(owner, robot, { id: nextId(), login: "never-came" });
    await post(`/robots/${robot.robotId}/members/${target}/remove`, owner, {});
    expect(await testEnv.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(target).first()).toBeNull();
  });

  it("a guest can leave; leaving the last share signs them out", async () => {
    const a = await invitedUser();
    const b = await invitedUser();
    const ra = await ownedRobot(a);
    const rb = await ownedRobot(b);
    const gh = { id: nextId(), login: "leaver" };
    await share(a, ra, gh);
    await share(b, rb, gh, "operator");
    const guest = (await signIn(gh))!;
    const first = await post(`/robots/${ra.robotId}/leave`, guest, {});
    expect(first.status).toBe(303);
    expect(first.headers.get("Location")).toBe("/?notice=left");
    expect(await (await get("/?notice=left", guest)).text()).toContain("You left that robot");
    const last = await post(`/robots/${rb.robotId}/leave`, guest, {});
    expect(last.headers.get("Location")).toBe("/?notice=left_last");
    expect(last.headers.getSetCookie().join()).toContain("__Host-mcr_session=;");
    expect(await signedOut(guest)).toBe(true);
    expect(await (await get("/?notice=left_last", null)).text()).toContain("You left the last robot shared with you");
    // The owner cannot leave their own robot (they unlink it), and leaving twice finds nothing.
    expect((await post(`/robots/${ra.robotId}/leave`, a, {})).status).toBe(404);
    expect(await member(ra.robotId, a.id)).toEqual({ role: "owner" });
  });
});

describe("sharing is the owner's", () => {
  it("everyone else gets the same 404 as for a robot that does not exist", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const op = { id: nextId(), login: "op-guest" };
    const vw = { id: nextId(), login: "vw-guest" };
    const opId = await share(owner, robot, op, "operator");
    const vwId = await share(owner, robot, vw, "viewer");
    const operator = (await signIn(op))!;
    const viewer = (await signIn(vw))!;
    const stranger = await invitedUser(); // can sign in and own robots, but not this one
    const missing = (await newRobot()).robotId;
    const notFound = await (await get(`/robots/${missing}/share`, owner)).text();
    for (const who of [operator, viewer, stranger]) {
      const page = await get(`/robots/${robot.robotId}/share`, who);
      expect(page.status).toBe(404);
      expect(await page.text()).toBe(notFound);
      for (const [path, form] of [
        ["share", { login: "someone", role: "viewer" }],
        ["share", { id: String(op.id), role: "operator" }],
        [`members/${vwId}/role`, { role: "operator" }],
        [`members/${opId}/remove`, {}],
        [`members/${owner.id}/remove`, {}],
        ["unlink", {}],
        ["sessions/revoke", {}],
      ] as const) {
        expect((await post(`/robots/${robot.robotId}/${path}`, who, form)).status).toBe(404);
      }
    }
    expect(await member(robot.robotId, vwId)).toEqual({ role: "viewer" });
    expect(await member(robot.robotId, opId)).toEqual({ role: "operator" });
    expect(lookups.filter((u) => u.includes("someone"))).toEqual([]); // no GitHub call for them
    expect((await testEnv.DB.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robot.robotId).first())!.status).toBe("claimed");
    // Signed out: the page asks for a login, the writes do nothing.
    expect((await get(`/robots/${robot.robotId}/share`, null)).headers.get("Location")).toMatch(/^\/login\?return_to=/);
    expect((await post(`/robots/${robot.robotId}/members/${vwId}/remove`, null, {})).headers.get("Location")).toBe("/login");
    expect(await member(robot.robotId, vwId)).toEqual({ role: "viewer" });
  });

  it("an owner who may no longer own robots cannot manage their shares, even signed in as a guest", async () => {
    const owner = await invitedUser("removed-owner");
    const robot = await ownedRobot(owner);
    const vwId = await share(owner, robot, { id: nextId(), login: "removed-owners-guest" });
    await testEnv.DB.prepare("DELETE FROM invites WHERE user_id = ?").bind(owner.id).run();
    // Someone else shares a robot with them, so they can still sign in, as a guest.
    const other = await invitedUser();
    await share(other, await ownedRobot(other), { id: Number(owner.id.slice(3)), login: "removed-owner" });
    expect(await signedOut(owner)).toBe(false);
    const missing = await (await get(`/robots/${(await newRobot()).robotId}/share`, owner)).text();
    const page = await get(`/robots/${robot.robotId}/share`, owner);
    expect(page.status).toBe(404);
    expect(await page.text()).toBe(missing);
    const before = lookups.length;
    accounts.push({ id: nextId(), login: "wanted-by-removed" });
    for (const [path, form] of [
      ["share", { login: "wanted-by-removed", role: "viewer" }],
      [`members/${vwId}/role`, { role: "operator" }],
      [`members/${vwId}/remove`, {}],
    ] as const) {
      expect((await post(`/robots/${robot.robotId}/${path}`, owner, form)).status).toBe(404);
    }
    expect(lookups.length).toBe(before); // no GitHub lookup budget spent
    expect(await member(robot.robotId, vwId)).toEqual({ role: "viewer" });
  });

  it("the owner cannot be demoted or removed, and no form makes anyone an owner", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "no-owner" };
    const target = await share(owner, robot, gh);
    expect((await post(`/robots/${robot.robotId}/members/${owner.id}/role`, owner, { role: "viewer" })).status).toBe(404);
    expect((await post(`/robots/${robot.robotId}/members/${owner.id}/remove`, owner, {})).status).toBe(404);
    expect(await member(robot.robotId, owner.id)).toEqual({ role: "owner" });
    for (const role of ["owner", "Owner", "admin", ""]) {
      expect((await post(`/robots/${robot.robotId}/members/${target}/role`, owner, { role })).status).toBe(400);
      expect((await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role })).status).toBe(400);
      expect((await post(`/robots/${robot.robotId}/share`, owner, { login: "someone-else", role })).status).toBe(400);
    }
    expect(await member(robot.robotId, target)).toEqual({ role: "viewer" });
    // The database refuses a second owner whatever the code does.
    await expect(
      testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, 'owner', 0)").bind(robot.robotId, (await newUser()).id).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("an owner cannot touch members of another owner's robot through their own", async () => {
    const a = await invitedUser();
    const b = await invitedUser();
    const ra = await ownedRobot(a);
    const rb = await ownedRobot(b);
    const target = await share(b, rb, { id: nextId(), login: "b-guest" });
    // A's own robot id, B's member: no such member on A's robot.
    expect((await post(`/robots/${ra.robotId}/members/${target}/remove`, a, {})).status).toBe(404);
    // B's robot id: A is not its owner.
    expect((await post(`/robots/${rb.robotId}/members/${target}/remove`, a, {})).status).toBe(404);
    expect(await member(rb.robotId, target)).toEqual({ role: "viewer" });
  });

  it("refuses cross-site requests (CSRF) and changes nothing", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "csrf-guest" };
    accounts.push(gh);
    const target = await share(owner, robot, { id: nextId(), login: "csrf-existing" });
    for (const headers of <Record<string, string>[]>[{}, { Origin: "https://evil.example" }, { Origin: "null" }, { Origin: "null", "Sec-Fetch-Site": "same-site" }, { Origin: `https://${robot.robotId}.robots.test` }]) {
      expect((await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role: "operator" }, headers)).status).toBe(403);
      expect((await post(`/robots/${robot.robotId}/members/${target}/role`, owner, { role: "operator" }, headers)).status).toBe(403);
      expect((await post(`/robots/${robot.robotId}/members/${target}/remove`, owner, {}, headers)).status).toBe(403);
    }
    expect(await member(robot.robotId, `gh:${gh.id}`)).toBeNull();
    expect(await member(robot.robotId, target)).toEqual({ role: "viewer" });
    // A same-origin form POST that sends Origin: null is fine.
    expect((await post(`/robots/${robot.robotId}/members/${target}/role`, owner, { role: "operator" }, { Origin: "null", "Sec-Fetch-Site": "same-origin" })).status).toBe(303);
  });

  it("escapes names from GitHub and the robot", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner, "<b>lawn</b>");
    const gh = { id: nextId(), login: "xss-guest", name: '<img src=x onerror="alert(1)">' };
    accounts.push(gh);
    const confirm = await (await post(`/robots/${robot.robotId}/share`, owner, { login: gh.login, role: "viewer" })).text();
    expect(confirm).not.toContain("<img src=x");
    expect(confirm).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(confirm).not.toContain("<b>lawn</b>");
    await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role: "viewer" });
    expect(await (await get(`/robots/${robot.robotId}/share`, owner)).text()).not.toContain("<img src=x");
  });
});

describe("sharing limits", () => {
  it("cannot share with yourself or again with someone who has access", async () => {
    const owner = await invitedUser("self-sharer");
    const robot = await ownedRobot(owner);
    accounts.push({ id: Number(owner.id.slice(3)), login: "self-sharer" });
    const self1 = await post(`/robots/${robot.robotId}/share`, owner, { login: "self-sharer", role: "viewer" });
    expect(self1.status).toBe(400);
    expect(await self1.text()).toContain("your own account");
    expect((await post(`/robots/${robot.robotId}/share`, owner, { id: owner.id.slice(3), role: "viewer" })).status).toBe(400);
    expect(await member(robot.robotId, owner.id)).toEqual({ role: "owner" });

    const gh = { id: nextId(), login: "already-in" };
    expect(await shareRows(owner.id)).toBe(0);
    const target = await share(owner, robot, gh, "viewer");
    expect(await shareRows(owner.id)).toBe(1); // a real share counts towards the hourly budget
    const again = await post(`/robots/${robot.robotId}/share`, owner, { login: "already-in", role: "operator" });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("already has access");
    // Step 2 with an existing member does not change their role either.
    const direct = await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role: "operator" });
    expect(direct.headers.get("Location")).toBe(`/robots/${robot.robotId}/share?notice=already`);
    expect(await member(robot.robotId, target)).toEqual({ role: "viewer" });
    expect(await shareRows(owner.id)).toBe(1); // nothing was shared, nothing counted
  });

  it("refuses organizations, bots and accounts that do not exist", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    accounts.push({ id: nextId(), login: "an-org", type: "Organization" });
    expect(await (await post(`/robots/${robot.robotId}/share`, owner, { login: "an-org", role: "viewer" })).text()).toContain("not a person");
    expect(await (await post(`/robots/${robot.robotId}/share`, owner, { login: "nobody-here", role: "viewer" })).text()).toContain("no GitHub account called nobody-here");
    expect((await post(`/robots/${robot.robotId}/share`, owner, { login: "bad login!", role: "viewer" })).status).toBe(400);
  });

  it(`shares a robot with at most ${MAX_SHARES_PER_ROBOT} people`, async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    for (let i = 0; i < MAX_SHARES_PER_ROBOT; i++) {
      const u = await newUser();
      await testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)").bind(robot.robotId, u.id, nowSeconds()).run();
    }
    expect(await (await get(`/robots/${robot.robotId}/share`, owner)).text()).toContain("the most it can be");
    const gh = { id: nextId(), login: "one-too-many" };
    accounts.push(gh);
    const res = await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role: "viewer" });
    expect(res.status).toBe(403);
    expect(await member(robot.robotId, `gh:${gh.id}`)).toBeNull();
    expect(await shareRows(owner.id)).toBe(0);
  });

  it(`adds at most ${SHARES_PER_OWNER_PER_HOUR} shares per owner and hour`, async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const now = nowSeconds();
    for (let i = 0; i < SHARES_PER_OWNER_PER_HOUR; i++) {
      await testEnv.DB.prepare("INSERT INTO share_events (user_id, kind, at) VALUES (?, 'share', ?)").bind(owner.id, now - 60).run();
    }
    const gh = { id: nextId(), login: "over-budget" };
    accounts.push(gh);
    const res = await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role: "viewer" });
    expect(res.status).toBe(429);
    expect(await member(robot.robotId, `gh:${gh.id}`)).toBeNull();
    expect(await shareRows(owner.id)).toBe(SHARES_PER_OWNER_PER_HOUR); // the refusal adds none
    expect(await testEnv.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(`gh:${gh.id}`).first()).toBeNull(); // nothing left behind
    // An hour later it works again.
    await testEnv.DB.prepare("UPDATE share_events SET at = at - 3600 WHERE user_id = ?").bind(owner.id).run();
    expect((await post(`/robots/${robot.robotId}/share`, owner, { id: String(gh.id), role: "viewer" })).status).toBe(303);
  });

  it(`looks up at most ${LOOKUPS_PER_PERSON_PER_HOUR} GitHub accounts per person and hour, found or not`, async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    for (let i = 0; i < LOOKUPS_PER_PERSON_PER_HOUR; i++) {
      expect((await post(`/robots/${robot.robotId}/share`, owner, { login: `probe-${i}`, role: "viewer" })).status).toBe(400);
    }
    const before = lookups.length;
    accounts.push({ id: nextId(), login: "real-one" });
    const res = await post(`/robots/${robot.robotId}/share`, owner, { login: "real-one", role: "viewer" });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("You looked up many GitHub accounts");
    expect(lookups.length).toBe(before); // GitHub was not asked
  });

  it(`looks up at most ${LOOKUPS_PER_HOUR} accounts per hour for the whole relay`, async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    await testEnv.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO share_events (user_id, kind, at) SELECT 'gh:' || (900000 + i), 'lookup', ? FROM n`,
    )
      .bind(LOOKUPS_PER_HOUR, nowSeconds())
      .run();
    const before = lookups.length;
    const res = await post(`/robots/${robot.robotId}/share`, owner, { login: "anyone", role: "viewer" });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("for everyone"); // not their own budget: they made no lookup
    expect(lookups.length).toBe(before);
    await testEnv.DB.prepare("DELETE FROM share_events WHERE user_id GLOB 'gh:9?????'").run();
  });

  it("the cron forgets budget records after an hour", async () => {
    const { runCleanup } = await import("../src/index");
    await testEnv.DB.prepare("INSERT INTO share_events (user_id, kind, at) VALUES ('gh:5', 'lookup', ?), ('gh:5', 'share', ?)").bind(nowSeconds() - 4000, nowSeconds()).run();
    await runCleanup(testEnv);
    expect((await testEnv.DB.prepare("SELECT kind FROM share_events WHERE user_id = 'gh:5'").all()).results).toEqual([{ kind: "share" }]);
  });
});

describe("guests", () => {
  it("cannot add robots: no form, and a valid code is refused and stays valid", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "no-claim" };
    await share(owner, robot, gh);
    const guest = (await signIn(gh))!;
    const home = await (await get("/", guest)).text();
    expect(home).toContain("ask the person who runs Mowgli Connect for an invitation");
    const other = await newRobot();
    const { pairingCode } = (await (await register(other)).json()) as { pairingCode: string };
    for (const step of ["preview", "confirm"]) {
      const res = await post("/claim", guest, { code: pairingCode, step });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("cannot add robots");
    }
    expect((await testEnv.DB.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(other.robotId).first())!.status).toBe("unclaimed");
    // Not even a pairing-code guess is spent or made: a guest cannot probe codes.
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM claim_failures WHERE user_id = ?").bind(guest.id).first<{ n: number }>())!.n).toBe(0);
    for (const bad of ["clover-hedgehog-dew", pairingCode]) {
      const res = await post("/claim", guest, { code: bad, step: "preview" });
      expect(await res.text()).not.toContain(other.robotId);
    }
    // The robot's real owner can still add it with the same code.
    expect((await post("/claim", owner, { code: pairingCode })).status).toBe(303);
  });

  it("lose access with their owner, and get it back when the owner does", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "follows-owner" };
    const target = await share(owner, robot, gh, "operator");
    const guest = (await signIn(gh))!;
    await testEnv.DB.prepare("DELETE FROM invites WHERE user_id = ?").bind(owner.id).run();
    expect(await signedOut(guest)).toBe(true);
    expect(await selfMembers(robot)).toEqual([]);
    expect(await signIn(gh)).toBeNull();
    await testEnv.DB.prepare("INSERT INTO invites (user_id, login, invited_by, created_at) VALUES (?, 'x', 'gh:1', 0)").bind(owner.id).run();
    expect(await signedOut(guest)).toBe(false);
    expect(await selfMembers(robot)).toContainEqual({ userId: target, role: "operator" });
  });

  it("do not count for robots that are no longer claimed", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "unlinked-guest" };
    await share(owner, robot, gh);
    const guest = (await signIn(gh))!;
    expect((await post(`/robots/${robot.robotId}/unlink`, owner, {})).status).toBe(303);
    expect(await signedOut(guest)).toBe(true);
  });

  it("lose their relay sessions and app devices when the robot is unlinked, so a later share does not revive them", async () => {
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "unlinked-revive" };
    const target = await share(owner, robot, gh, "operator");
    const guest = (await signIn(gh))!;
    await addDevice(target);
    const never = await share(owner, robot, { id: nextId(), login: "unlinked-never" });
    expect((await post(`/robots/${robot.robotId}/unlink`, owner, {})).status).toBe(303);
    expect(await count("sessions", target)).toBe(0);
    expect(await count("devices", target)).toBe(0);
    expect(await count("users", never, "id")).toBe(0); // the account made for the share is gone too
    // Shared with again later: the old browser session and app device stay signed out.
    await share(owner, await ownedRobot(owner), gh);
    expect(await signedOut(guest)).toBe(true);
    expect(await count("devices", target)).toBe(0);
  });

  it("lose their relay sessions when the admin unlinks the robot of a removed owner", async () => {
    const admin = await newUser("unlink-admin");
    const aenv: Env = { ...env, ADMIN_GITHUB_IDS: admin.id };
    for (const how of ["remove", "orphan"] as const) {
      const owner = await invitedUser();
      const robot = await ownedRobot(owner);
      const gh = { id: nextId(), login: `admin-unlinked-${how}` };
      const target = await share(owner, robot, gh);
      await signIn(gh);
      await addDevice(target);
      if (how === "remove") {
        expect((await post(`/admin/people/${owner.id}/remove`, admin, { unlink: "1" }, { Origin: ORIGIN }, aenv)).headers.get("Location")).toBe("/admin?notice=removed_unlinked");
      } else {
        await testEnv.DB.prepare("DELETE FROM invites WHERE user_id = ?").bind(owner.id).run();
        expect((await post(`/admin/robots/${robot.robotId}/unlink`, admin, {}, { Origin: ORIGIN }, aenv)).headers.get("Location")).toBe("/admin?notice=unlinked");
      }
      expect((await testEnv.DB.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robot.robotId).first())!.status).toBe("revoked");
      expect(await count("sessions", target)).toBe(0);
      expect(await count("devices", target)).toBe(0);
    }
  });

  it("the cron forgets accounts made for a share once no share is left", async () => {
    const { runCleanup } = await import("../src/index");
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const kept = await share(owner, robot, { id: nextId(), login: "cron-kept" });
    const orphan = `gh:${nextId()}`;
    await testEnv.DB.prepare("INSERT INTO users (id, login, created_at, last_login_at) VALUES (?, 'cron-orphan', 0, 0)").bind(orphan).run();
    const signedIn = await newUser(); // no robots at all, but signed in: stays
    await runCleanup(testEnv);
    expect(await count("users", orphan, "id")).toBe(0);
    expect(await count("users", kept, "id")).toBe(1);
    expect(await count("users", signedIn.id, "id")).toBe(1);
  });

  it("sign in through a live share however many of their other shares lost their owner", async () => {
    const gh = { id: nextId(), login: "many-shares" };
    const guestId = `gh:${gh.id}`;
    const now = nowSeconds();
    const steps = [testEnv.DB.prepare("INSERT INTO users (id, login, created_at, last_login_at) VALUES (?, ?, 0, 0)").bind(guestId, gh.login)];
    for (let i = 0; i < 25; i++) {
      const gone = await newUser(); // never invited: may not own robots
      const rid = `x${String(gh.id).padStart(9, "0")}${String(i).padStart(6, "0")}`;
      steps.push(
        testEnv.DB.prepare("INSERT INTO robots (robot_id, public_key, status, created_at, updated_at, last_seen_at) VALUES (?, ?, 'claimed', ?, ?, ?)").bind(rid, `pk-${rid}`, now, now, now),
        testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?), (?, ?, 'viewer', ?)").bind(rid, gone.id, now, rid, guestId, now),
      );
    }
    await testEnv.DB.batch(steps);
    expect(await signIn(gh)).toBeNull();
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    await testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)").bind(robot.robotId, guestId, now).run();
    expect(await signIn(gh)).not.toBeNull();
  });

  it("an admin removing an invited person also removes the robots shared with them", async () => {
    const admin = await newUser("the-admin");
    const aenv: Env = { ...env, ADMIN_GITHUB_IDS: admin.id };
    const owner = await invitedUser();
    const robot = await ownedRobot(owner);
    const gh = { id: nextId(), login: "invited-and-shared" };
    const target = await share(owner, robot, gh);
    await testEnv.DB.prepare("INSERT INTO invites (user_id, login, invited_by, created_at) VALUES (?, ?, ?, 0)").bind(target, gh.login, admin.id).run();
    const res = await post(`/admin/people/${target}/remove`, admin, {}, { Origin: ORIGIN }, aenv);
    expect(res.status).toBe(303);
    expect(await member(robot.robotId, target)).toBeNull();
    expect(await signIn(gh)).toBeNull();
  });
});

describe("migration 0009", () => {
  it("allows the three roles only, keeps the foreign keys and the user index", async () => {
    const owner = await newUser();
    const robot = (await newRobot()).robotId;
    await testEnv.DB.prepare("INSERT INTO robots (robot_id, public_key, status, created_at, updated_at, last_seen_at) VALUES (?, ?, 'claimed', 0, 0, 0)").bind(robot, `k-${robot}`).run();
    for (const role of ["owner", "operator", "viewer"]) {
      const u = role === "owner" ? owner : await newUser();
      await testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, ?, 0)").bind(robot, u.id, role).run();
    }
    await expect(
      testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, 'admin', 0)").bind(robot, (await newUser()).id).run(),
    ).rejects.toThrow(/CHECK/);
    const fks = await testEnv.DB.prepare("SELECT \"table\", \"from\", on_delete FROM pragma_foreign_key_list('members') ORDER BY \"from\"").all();
    expect(fks.results).toEqual([
      { table: "robots", from: "robot_id", on_delete: "CASCADE" },
      { table: "users", from: "user_id", on_delete: "CASCADE" },
    ]);
    const idx = await testEnv.DB.prepare("SELECT name FROM pragma_index_list('members') ORDER BY name").all<{ name: string }>();
    expect(idx.results.map((r) => r.name)).toEqual(expect.arrayContaining(["members_one_owner_idx", "members_user_idx"]));
    // Deleting the robot still removes its members.
    await testEnv.DB.prepare("DELETE FROM robots WHERE robot_id = ?").bind(robot).run();
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE robot_id = ?").bind(robot).first<{ n: number }>())!.n).toBe(0);
  });

  it("keeps existing members when it rebuilds the table", async () => {
    // Replay 0009 on a copy shaped like the old table, with rows in it.
    const db = testEnv.DB;
    await db.batch([
      db.prepare("CREATE TABLE m9_users (id TEXT PRIMARY KEY)"),
      db.prepare("INSERT INTO m9_users VALUES ('gh:1'), ('gh:2')"),
    ]);
    const old = "CREATE TABLE members (robot_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'viewer')), label TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (robot_id, user_id))";
    // @ts-expect-error -- a Vite raw import, which has no type declaration here
    const sql = (await import("../migrations/0009_sharing.sql?raw")).default as string;
    const statements = (s: string) =>
      s
        .replace(/--.*$/gm, "")
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x) => !/share_events/.test(x))
        .map((x) => x.replace(/\bmembers_new\b/g, "m9_members_new").replace(/\bmembers\b/g, "m9_members").replace(/REFERENCES robots\(robot_id\) ON DELETE CASCADE/, "").replace(/REFERENCES users\(id\)/, "REFERENCES m9_users(id)").replace(/\b(members_user_idx|members_one_owner_idx)\b/g, "m9_$1"));
    await db.batch([
      db.prepare(old.replace("members", "m9_members")),
      db.prepare("INSERT INTO m9_members VALUES ('r1', 'gh:1', 'owner', 'Lawn', 5), ('r1', 'gh:2', 'viewer', NULL, 6)"),
    ]);
    await db.batch(statements(sql).map((x) => db.prepare(x)));
    expect((await db.prepare("SELECT * FROM m9_members ORDER BY user_id").all()).results).toEqual([
      { robot_id: "r1", user_id: "gh:1", role: "owner", label: "Lawn", created_at: 5 },
      { robot_id: "r1", user_id: "gh:2", role: "viewer", label: null, created_at: 6 },
    ]);
    await db.prepare("INSERT INTO m9_members VALUES ('r1', 'gh:1', 'operator', NULL, 7) ON CONFLICT DO UPDATE SET role = excluded.role").run();
    await db.batch([db.prepare("DROP TABLE m9_members"), db.prepare("DROP TABLE m9_users")]);
  });
});
