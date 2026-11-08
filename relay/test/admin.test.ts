import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { call, newRobot, newUser, ORIGIN, register, self, testEnv, type TestUser } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

interface GhProfile {
  id: number;
  login: string;
  name?: string | null;
  type?: string;
  created_at?: string;
}

/** Fakes api.github.com /users/<login> and /user/<id> for the given profiles. */
function stubGithub(profiles: GhProfile[]) {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    const byLogin = /^https:\/\/api\.github\.com\/users\/([^/]+)$/.exec(url);
    const byId = /^https:\/\/api\.github\.com\/user\/(\d+)$/.exec(url);
    const p = profiles.find((x) =>
      byLogin ? x.login.toLowerCase() === decodeURIComponent(byLogin[1]!).toLowerCase() : byId ? String(x.id) === byId[1] : false,
    );
    if (!p) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return Response.json({ type: "User", name: null, created_at: "2015-04-01T00:00:00Z", ...p });
  });
  return calls;
}

let admin: TestUser;
let env: Env;

async function setup(extra: Partial<Env> = {}) {
  await testEnv.DB.prepare("DELETE FROM settings").run(); // tests in this file share the database
  admin = await newUser("boss");
  env = { ...testEnv, ALLOWED_GITHUB_LOGINS: "", ADMIN_GITHUB_IDS: admin.id, ...extra };
}

function get(path: string, user: TestUser | null, e: Env = env) {
  return call(path, { headers: user ? { Cookie: user.cookie } : {}, redirect: "manual" }, e);
}

function post(path: string, user: TestUser | null, form: Record<string, string>, origin = ORIGIN, e: Env = env) {
  return call(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...(user ? { Cookie: user.cookie } : {}) },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    },
    e,
  );
}

const invites = () => testEnv.DB.prepare("SELECT * FROM invites ORDER BY created_at").all<Record<string, unknown>>();

async function invite(login: string, id: number) {
  const step1 = await post("/admin/invite", admin, { login });
  expect(step1.status).toBe(200);
  const res = await post("/admin/invite", admin, { id: String(id) });
  expect(res.status).toBe(303);
  return res;
}

describe("admin page access", () => {
  it("exists only for admins, by GitHub id", async () => {
    await setup();
    expect((await get("/admin", admin)).status).toBe(200);
    expect(await (await get("/", admin)).text()).toContain('href="/admin"');
    const other = await newUser("visitor");
    const open = { ...env, ALLOWED_GITHUB_LOGINS: "*" };
    for (const [u, e] of [[null, env], [other, open]] as const) {
      const res = await get("/admin", u, e);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("Invite someone");
    }
    expect(await (await get("/", other, open)).text()).not.toContain('href="/admin"');
    // A login is never enough, even the admin's own.
    expect((await get("/admin", admin, { ...env, ADMIN_GITHUB_IDS: "boss", ALLOWED_GITHUB_LOGINS: "*" })).status).toBe(404);
  });

  it("refuses writes from non-admins and from other sites, and changes nothing", async () => {
    await setup();
    const calls = stubGithub([{ id: 7001, login: "mallory" }]);
    const other = await newUser("mallory");
    const open = { ...env, ALLOWED_GITHUB_LOGINS: "*" };
    expect((await post("/admin/invite", other, { id: "7001" }, ORIGIN, open)).status).toBe(404);
    expect((await post("/admin/settings", other, { default_limit: "50" }, ORIGIN, open)).status).toBe(404);
    expect((await post("/admin/invite", admin, { id: "7001" }, "https://evil.example")).status).toBe(403);
    expect((await post("/admin/settings", admin, { default_limit: "50" }, "https://evil.example")).status).toBe(403);
    expect((await invites()).results.find((r) => r.user_id === "gh:7001")).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await testEnv.DB.prepare("SELECT value FROM settings WHERE key = 'default_robot_limit'").first()).toBeNull();
  });
});

describe("inviting", () => {
  it("shows the account first, then stores it by id with GitHub's own login", async () => {
    await setup();
    const calls = stubGithub([{ id: 7101, login: "Octo-Cat", name: "The Octocat" }]);
    const step1 = await post("/admin/invite", admin, { login: "  https://github.com/octo-cat/ " });
    const body = await step1.text();
    expect(body).toContain("Invite @Octo-Cat?");
    expect(body).toContain("The Octocat");
    expect(body).toContain('name="id" value="7101"');
    expect((await invites()).results.find((r) => r.user_id === "gh:7101")).toBeUndefined(); // nothing stored yet
    const res = await post("/admin/invite", admin, { id: "7101" });
    expect(res.headers.get("Location")).toBe("/admin?notice=invited");
    const row = (await invites()).results.find((r) => r.user_id === "gh:7101")!;
    expect(row).toMatchObject({ login: "Octo-Cat", name: "The Octocat", robot_limit: null, invited_by: admin.id });
    // GitHub is asked with the app's credentials, never a user token.
    expect(calls.every((c) => c.auth?.startsWith("Basic "))).toBe(true);
    // Inviting again changes nothing.
    expect((await post("/admin/invite", admin, { id: "7101" })).headers.get("Location")).toBe("/admin?notice=already");
    expect(await (await get("/admin", admin)).text()).toContain("@Octo-Cat");
  });

  it("lets the invited person sign in, by id even after a rename", async () => {
    await setup();
    stubGithub([{ id: 7201, login: "alice" }]);
    await invite("alice", 7201);
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("INSERT INTO users (id, login, name, created_at, last_login_at) VALUES ('gh:7201', 'alice-renamed', NULL, ?, ?)").bind(now, now).run();
    const { createSession } = await import("../src/session");
    const alice = { id: "gh:7201", cookie: `__Host-mcr_session=${await createSession(testEnv, "gh:7201")}` };
    expect(await (await get("/", alice)).text()).toContain("Signed in as");
    // Somebody who took the old login gets nothing.
    const squatter = await newUser("alice");
    expect(await (await get("/", squatter)).text()).toContain("Sign in with GitHub");
  });

  it("rejects bad usernames, unknown accounts and organizations", async () => {
    await setup();
    stubGithub([{ id: 7301, login: "some-org", type: "Organization" }]);
    for (const login of ["", "-bad", "a--b", "x".repeat(40), "<script>", "../users"]) {
      const res = await post("/admin/invite", admin, { login });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("<script>");
    }
    expect(await (await post("/admin/invite", admin, { login: "nobody-here" })).text()).toContain("There is no GitHub account called nobody-here");
    expect(await (await post("/admin/invite", admin, { login: "some-org" })).text()).toContain("organization or a bot");
    expect(await (await post("/admin/invite", admin, { id: "7301" })).text()).toContain("organization or a bot");
    for (const id of ["0", "-1", "abc", "1".repeat(21)]) expect((await post("/admin/invite", admin, { id })).status).toBe(400);
    expect((await invites()).results.find((r) => r.user_id === "gh:7301")).toBeUndefined();
  });
});

describe("removing access", () => {
  it("ends the person's sessions and drops them from their robots", async () => {
    await setup();
    stubGithub([{ id: 7401, login: "bob" }]);
    await invite("bob", 7401);
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("INSERT INTO users (id, login, name, created_at, last_login_at) VALUES ('gh:7401', 'bob', NULL, ?, ?)").bind(now, now).run();
    const { createSession } = await import("../src/session");
    const bob = { id: "gh:7401", cookie: `__Host-mcr_session=${await createSession(testEnv, "gh:7401")}` };
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "bobs-mower")).json()) as { pairingCode: string };
    expect((await post("/claim", bob, { code: pairingCode })).status).toBe(303);
    const members = async () =>
      ((await (await call("/v1/robots/self", { headers: { Authorization: (await selfAuth(robot)) } }, env)).json()) as { members: unknown[] }).members;
    expect(await members()).toEqual([{ userId: "gh:7401", role: "owner" }]);

    const res = await post("/admin/people/gh:7401/remove", admin, {});
    expect(res.headers.get("Location")).toBe("/admin?notice=removed");
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'gh:7401'").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await (await get("/", bob)).text()).toContain("Sign in with GitHub");
    expect(await members()).toEqual([]);
    expect((await post("/admin/people/gh:7401/remove", admin, {})).status).toBe(404);
  });
});

async function selfAuth(robot: Awaited<ReturnType<typeof newRobot>>): Promise<string> {
  const { assertion } = await import("./helpers");
  return assertion(robot, "GET", "/v1/robots/self");
}

describe("robot limits", () => {
  async function invitedUser(id: number) {
    stubGithub([{ id, login: `u${id}` }]);
    await invite(`u${id}`, id);
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare("INSERT INTO users (id, login, name, created_at, last_login_at) VALUES (?, ?, NULL, ?, ?)").bind(`gh:${id}`, `u${id}`, now, now).run();
    const { createSession } = await import("../src/session");
    return { id: `gh:${id}`, cookie: `__Host-mcr_session=${await createSession(testEnv, `gh:${id}`)}` };
  }
  async function newCode(name = "lawn bot") {
    const robot = await newRobot();
    return ((await (await register(robot, name)).json()) as { pairingCode: string }).pairingCode;
  }

  it("allows three robots by default, keeps the fourth code valid, and follows the admin's changes", async () => {
    await setup();
    const u = await invitedUser(7501);
    for (let i = 0; i < 3; i++) expect((await post("/claim", u, { code: await newCode() })).status).toBe(303);
    expect(await (await get("/", u)).text()).toContain("Your account is full");
    const fourth = await newCode();
    const refused = await post("/claim", u, { code: fourth });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("You already have 3 robots");
    const preview = await post("/claim", u, { code: fourth, step: "preview" });
    expect(preview.status).toBe(403);

    // A personal limit of 4: the same code still works.
    expect((await post("/admin/people/gh:7501/limit", admin, { limit: "4" })).headers.get("Location")).toBe("/admin?notice=limit");
    expect((await post("/claim", u, { code: fourth })).status).toBe(303);
    expect(await (await get("/admin", admin)).text()).toContain("4 of 4 robots");

    // Back to the default, now 1: existing robots stay, new ones are refused.
    expect((await post("/admin/people/gh:7501/limit", admin, { limit: "" })).status).toBe(303);
    expect((await post("/admin/settings", admin, { default_limit: "1" })).status).toBe(303);
    expect((await post("/claim", u, { code: await newCode() })).status).toBe(403);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE user_id = 'gh:7501'").first<{ n: number }>())!.n).toBe(4);
  });

  it("validates limits", async () => {
    await setup();
    await invitedUser(7601);
    for (const limit of ["-1", "101", "abc", "1.5", "1e2"]) {
      expect((await post("/admin/people/gh:7601/limit", admin, { limit })).status).toBe(400);
      expect((await post("/admin/settings", admin, { default_limit: limit })).status).toBe(400);
    }
    expect((await post("/admin/people/gh:9999999/limit", admin, { limit: "2" })).status).toBe(404);
    expect((await post("/admin/settings", admin, { default_limit: "0" })).status).toBe(303);
  });

  it("holds when another robot fills the account while one is being added", async () => {
    await setup();
    const u = await invitedUser(7701);
    await post("/admin/people/gh:7701/limit", admin, { limit: "1" });
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "racer")).json()) as { pairingCode: string };
    const other = await newRobot();
    await register(other, "other");
    const { claimRobot } = await import("../src/claim");
    const { robotHostname } = await import("../src/provisioner");
    const deprovisioned: string[] = [];
    const stub = {
      assignsHostnames: true,
      async provision(robotId: string, label?: string) {
        // Meanwhile, another robot is claimed for the same account.
        const now = Math.floor(Date.now() / 1000);
        await testEnv.DB.batch([
          testEnv.DB.prepare("UPDATE robots SET status = 'claimed' WHERE robot_id = ?").bind(other.robotId),
          testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, label, created_at) VALUES (?, ?, 'owner', NULL, ?)").bind(other.robotId, u.id, now),
        ]);
        return { hostname: robotHostname(label ?? robotId, "robots.test"), tunnelId: "t-race", dnsRecordId: "d", token: "tok" };
      },
      async deprovision(ref: { robotId: string }) {
        deprovisioned.push(ref.robotId);
      },
    };
    const res = await claimRobot(env, stub, u.id, pairingCode, null);
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(deprovisioned).toEqual([robot.robotId]);
    const row = await testEnv.DB.prepare("SELECT status, hostname FROM robots WHERE robot_id = ?").bind(robot.robotId).first();
    expect(row).toEqual({ status: "unclaimed", hostname: null });
    expect(((await (await self(robot)).json()) as { status: string }).status).toBe("unclaimed");
    expect(await testEnv.DB.prepare("SELECT 1 AS ok FROM pairing_codes WHERE robot_id = ?").bind(robot.robotId).first()).not.toBeNull();
  });
});

describe("address before adding", () => {
  it("shows the address, numbers a taken name, re-checks a changed name, and adds on confirm", async () => {
    await setup({ ALLOWED_GITHUB_LOGINS: "*" });
    const first = await newUser();
    const r1 = await newRobot();
    const c1 = ((await (await register(r1, "x")).json()) as { pairingCode: string }).pairingCode;
    expect((await post("/claim", first, { code: c1, label: "Back yard" })).status).toBe(303);

    const u = await newUser();
    const r2 = await newRobot();
    const code = ((await (await register(r2, "mower")).json()) as { pairingCode: string }).pairingCode;
    const preview = await post("/claim", u, { code, label: "Back yard", step: "preview" });
    const body = await preview.text();
    expect(body).toContain("back-yard-2.robots.test");
    expect(body).toContain("back-yard.robots.test is taken");
    expect(await testEnv.DB.prepare("SELECT 1 AS ok FROM pairing_codes WHERE robot_id = ?").bind(r2.robotId).first()).not.toBeNull();

    const changed = await post("/claim", u, { code, label: "Front lawn", shown_label: "Back yard", step: "confirm" });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain("front-lawn.robots.test");
    expect(((await (await self(r2)).json()) as { status: string }).status).toBe("unclaimed");

    const done = await post("/claim", u, { code, label: "Front lawn", shown_label: "Front lawn", step: "confirm" });
    expect(done.status).toBe(303);
    expect(((await (await self(r2)).json()) as { hostname: string }).hostname).toBe("front-lawn.robots.test");
  });
});
