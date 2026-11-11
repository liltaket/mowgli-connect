import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { call, get, newUser, ORIGIN, registerAndClaim, self, testEnv, type TestUser } from "./helpers";

let admin: TestUser;
let env: Env;

beforeEach(async () => {
  await testEnv.DB.prepare("DELETE FROM settings").run();
  admin = await newUser("boss");
  env = { ...testEnv, ADMIN_GITHUB_IDS: admin.id };
});
afterEach(() => vi.unstubAllGlobals());

function adminPost(path: string, user: TestUser | null, form: Record<string, string>, origin = ORIGIN) {
  return call(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...(user ? { Cookie: user.cookie } : {}) },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    },
    env,
  );
}

const engage = (user: TestUser | null = admin) => adminPost("/admin/kill", user, { confirm: "1" });
const resume = (user: TestUser | null = admin) => adminPost("/admin/resume", user, {});
const robotState = async (robot: Parameters<typeof self>[0]) => (await (await self(robot)).json()) as Record<string, any>;
const sessionCount = async (u: TestUser) => (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n;

describe("emergency stop", () => {
  it("is for admins only, needs the confirmation and our own Origin", async () => {
    const other = await newUser("visitor");
    expect((await engage(other)).status).toBe(404);
    expect((await engage(null)).status).toBe(404);
    expect((await adminPost("/admin/kill", admin, {})).status).toBe(400);
    expect((await adminPost("/admin/kill", admin, { confirm: "1" }, "https://evil.example")).status).toBe(403);
    expect((await resume(other)).status).toBe(404);
    expect(await testEnv.DB.prepare("SELECT 1 FROM settings WHERE key = 'kill_switch'").first()).toBeNull();
  });

  it("ends sessions, withholds the tunnel token and members from robots, and refuses to open robots", async () => {
    const owner = await newUser("owner");
    const { robot } = await registerAndClaim(owner);
    const mine = await registerAndClaim(admin);
    const before = await robotState(robot);
    expect(before.tunnelToken).toBeTruthy();
    expect(before.members).toHaveLength(1);
    expect((await get(`/open/${robot.robotId}`, owner)).status).toBe(302);

    const res = await engage();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/admin?notice=killed");

    // A robot is told to stop its tunnel and accept nobody, and the epoch moved on.
    const during = await robotState(robot);
    expect(during).toMatchObject({ status: "claimed", tunnelToken: null, members: [], paused: true });
    expect(during.sessionEpoch).toBeGreaterThan(before.sessionEpoch);

    // Non-admin sessions are gone, the admin's survives so the stop can be lifted.
    expect(await sessionCount(owner)).toBe(0);
    expect(await (await get("/", owner)).text()).not.toContain(`/open/${robot.robotId}`);
    expect(await sessionCount(admin)).toBe(1);
    expect((await call("/admin", { headers: { Cookie: admin.cookie } }, env)).status).toBe(200);
    expect(await (await call("/admin", { headers: { Cookie: admin.cookie } }, env)).text()).toContain("Emergency stop is on");

    // Nobody, admin included, gets a grant while it is on.
    expect((await call(`/open/${mine.robot.robotId}`, { headers: { Cookie: admin.cookie }, redirect: "manual" }, env)).status).toBe(503);
  });

  it("turning it off brings back access, but not the sessions from before", async () => {
    const owner = await newUser("owner2");
    const { robot } = await registerAndClaim(owner);
    const epoch0 = (await robotState(robot)).sessionEpoch;
    await engage();
    const epochKilled = (await robotState(robot)).sessionEpoch;

    const res = await resume();
    expect(res.headers.get("Location")).toBe("/admin?notice=resumed");
    const after = await robotState(robot);
    expect(after.paused).toBeUndefined();
    expect(after.tunnelToken).toBeTruthy();
    expect(after.members).toHaveLength(1);
    expect(after.sessionEpoch).toBe(epochKilled);
    expect(epochKilled).toBeGreaterThan(epoch0);
    expect(await sessionCount(owner)).toBe(0);
  });

  it("refuses a new GitHub sign-in from anyone but an admin", async () => {
    await engage();
    const signIn = async (id: number, login: string) => {
      const start = await get("/login", null);
      const state = new URL(start.headers.get("Location")!).searchParams.get("state")!;
      const cookie = start.headers.getSetCookie().find((c) => c.startsWith("__Host-mcr_oauth="))!.split(";")[0]!;
      vi.stubGlobal("fetch", async (input: string | Request) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_fake" });
        if (url === "https://api.github.com/user") return Response.json({ id, login, name: null, two_factor_authentication: true });
        return new Response("unexpected", { status: 500 });
      });
      return call(`/auth/github/callback?code=c&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" }, env);
    };
    const visitor = await signIn(888001, "visitor-kill");
    expect(visitor.status).toBe(503);
    expect(visitor.headers.getSetCookie().some((c) => c.startsWith("__Host-mcr_session=") && !c.includes("Max-Age=0"))).toBe(false);
    expect(await testEnv.DB.prepare("SELECT 1 FROM users WHERE id = 'gh:888001'").first()).toBeNull();

    const adminId = Number(admin.id.slice(3));
    const boss = await signIn(adminId, "boss");
    expect(boss.status).toBe(302);
  });
});
