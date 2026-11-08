import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { b64urlEncode } from "../src/crypto";
import { call, newRobot, newUser, ORIGIN, register, assertion, testEnv, type TestUser } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const KEY = b64urlEncode(new Uint8Array(32).fill(7));

function post(path: string, user: TestUser, form: Record<string, string>, e: Env) {
  return call(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, Cookie: user.cookie },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    },
    e,
  );
}

async function selfBody(robot: Awaited<ReturnType<typeof newRobot>>, e: Env) {
  const res = await call("/v1/robots/self", { headers: { Authorization: await assertion(robot, "GET", "/v1/robots/self") } }, e);
  return (await res.json()) as { status: string; tunnelToken: string | null; members: unknown[] };
}

async function claimed(e: Env, user?: TestUser) {
  const u = user ?? (await newUser());
  const robot = await newRobot();
  const { pairingCode } = (await (await register(robot, "sealed")).json()) as { pairingCode: string };
  expect((await post("/claim", u, { code: pairingCode }, e)).status).toBe(303);
  return { robot, user: u };
}

describe("tunnel tokens at rest", () => {
  it("are stored sealed, bound to their robot, and handed to the robot in clear", async () => {
    const e = { ...testEnv, TUNNEL_TOKEN_KEY: KEY };
    const { robot } = await claimed(e);
    const row = await testEnv.DB.prepare("SELECT tunnel_token FROM robots WHERE robot_id = ?").bind(robot.robotId).first<{ tunnel_token: string }>();
    expect(row!.tunnel_token.startsWith("v1.")).toBe(true);
    const body = await selfBody(robot, e);
    expect(body.tunnelToken).toBeTruthy();
    expect(body.tunnelToken!.startsWith("v1.")).toBe(false);
    expect(row!.tunnel_token).not.toContain(body.tunnelToken!);

    // A sealed token copied to another robot's row does not open there.
    const { openToken } = await import("../src/tokenSeal");
    expect(await openToken(e, "aaaaaaaaaaaaaaaa", row!.tunnel_token)).toBeNull();
    // Without the key (or with another one) it does not open at all.
    expect((await selfBody(robot, testEnv)).tunnelToken).toBeNull();
    expect(await openToken({ ...testEnv, TUNNEL_TOKEN_KEY: b64urlEncode(new Uint8Array(32).fill(8)) }, robot.robotId, row!.tunnel_token)).toBeNull();
  });

  it("seals plain-text tokens stored before the key was set", async () => {
    const { robot } = await claimed(testEnv);
    const plain = (await selfBody(robot, testEnv)).tunnelToken!;
    expect(plain).toBeTruthy();
    const e = { ...testEnv, TUNNEL_TOKEN_KEY: KEY };
    expect((await selfBody(robot, e)).tunnelToken).toBe(plain); // plain rows still work
    const { sealStoredTokens } = await import("../src/tokenSeal");
    expect(await sealStoredTokens(e)).toBeGreaterThanOrEqual(1);
    const row = await testEnv.DB.prepare("SELECT tunnel_token FROM robots WHERE robot_id = ?").bind(robot.robotId).first<{ tunnel_token: string }>();
    expect(row!.tunnel_token.startsWith("v1.")).toBe(true);
    expect((await selfBody(robot, e)).tunnelToken).toBe(plain);
  });
});

describe("operator alerts", () => {
  it("posts to ntfy at most once per kind, and never without a URL", async () => {
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
      sent.push({ url: typeof input === "string" ? input : input.url, body: String(init?.body) });
      return new Response("ok");
    });
    const { alert } = await import("../src/alerts");
    await alert(testEnv, "test_kind", "first");
    expect(sent).toHaveLength(0);
    const e = { ...testEnv, ALERT_NTFY_URL: "https://ntfy.example/topic" };
    await alert(e, "test_kind", "first");
    await alert(e, "test_kind", "second");
    await alert(e, "other_kind", "third");
    expect(sent.map((s) => s.body)).toEqual(["first", "third"]);
    expect(sent[0]!.url).toBe("https://ntfy.example/topic");
  });

  it("does not fail the caller when ntfy is down", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const { alert } = await import("../src/alerts");
    await expect(alert({ ...testEnv, ALERT_NTFY_URL: "https://ntfy.example/t" }, "down_kind", "x")).resolves.toBeUndefined();
  });
});

describe("agent updates", () => {
  it("tells whether a robot runs an older agent", async () => {
    const { updateAvailable } = await import("../src/updates");
    const latest = "422d1b139371d83508605b73281c61c8f2b52f92";
    expect(updateAvailable("main-422d1b139371d83508605b73281c61c8f2b", latest)).toBe(false);
    expect(updateAvailable("main-96ba7732b3eefeef528ce95288a6a83bd2a", latest)).toBe(true);
    for (const v of [null, "dev", "callback-ui", "agent-v1.0-abc", "main-xyz"]) expect(updateAvailable(v, latest)).toBeNull();
    expect(updateAvailable("main-422d1b1", null)).toBeNull();
  });

  it("learns the latest build from GitHub and shows owners that an update is available", async () => {
    const latest = "1111111111111111111111111111111111111111";
    vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (init?.redirect !== "manual") throw new TypeError("Invalid redirect value");
      if (url.includes("/actions/workflows/agent-image.yml/runs")) {
        return Response.json({ workflow_runs: [{ head_sha: "2".repeat(40), event: "pull_request" }, { head_sha: latest, event: "push" }] });
      }
      return new Response("unexpected", { status: 500 });
    });
    await testEnv.DB.prepare("DELETE FROM settings WHERE key LIKE 'latest_agent%'").run();
    const { refreshLatestAgent, latestAgentSha } = await import("../src/updates");
    await refreshLatestAgent(testEnv);
    expect(await latestAgentSha(testEnv)).toBe(latest);
    vi.unstubAllGlobals();

    const { robot, user } = await claimed(testEnv);
    await testEnv.DB.prepare("UPDATE robots SET agent_version = 'main-2222222222222' WHERE robot_id = ?").bind(robot.robotId).run();
    const page = await (await call("/", { headers: { Cookie: user.cookie } })).text();
    expect(page).toContain("Update available");
    await testEnv.DB.prepare("UPDATE robots SET agent_version = 'main-1111111' WHERE robot_id = ?").bind(robot.robotId).run();
    expect(await (await call("/", { headers: { Cookie: user.cookie } })).text()).not.toContain("Update available");
  });
});

describe("admin: robots of people without access", () => {
  async function setup() {
    const admin = await newUser("ops-admin");
    const e: Env = { ...testEnv, ALLOWED_GITHUB_LOGINS: "", ADMIN_GITHUB_IDS: admin.id };
    return { admin, e };
  }
  async function invited(e: Env, admin: TestUser) {
    const u = await newUser();
    await testEnv.DB.prepare("INSERT INTO invites (user_id, login, name, robot_limit, invited_by, created_at) VALUES (?, 'x', NULL, NULL, ?, 0)").bind(u.id, admin.id).run();
    return u;
  }

  it("removes access and unlinks the person's robots when asked", async () => {
    const { admin, e } = await setup();
    const u = await invited(e, admin);
    const { robot } = await claimed(e, u);
    const res = await post(`/admin/people/${u.id}/remove`, admin, { unlink: "1" }, e);
    expect(res.headers.get("Location")).toBe("/admin?notice=removed_unlinked");
    expect((await selfBody(robot, e)).status).toBe("revoked");
  });

  it("lists robots nobody can use and unlinks only those", async () => {
    const { admin, e } = await setup();
    const gone = await invited(e, admin);
    const { robot: orphan } = await claimed(e, gone);
    await post(`/admin/people/${gone.id}/remove`, admin, {}, e);
    const kept = await invited(e, admin);
    const { robot: fine } = await claimed(e, kept);

    const page = await (await call("/admin", { headers: { Cookie: admin.cookie } }, e)).text();
    expect(page).toContain("Robots nobody can use");
    expect(page).toContain(`/admin/robots/${orphan.robotId}/unlink`);
    expect(page).not.toContain(`/admin/robots/${fine.robotId}/unlink`);

    expect((await post(`/admin/robots/${fine.robotId}/unlink`, admin, {}, e)).status).toBe(404);
    expect((await selfBody(fine, e)).status).toBe("claimed");
    expect((await post(`/admin/robots/${orphan.robotId}/unlink`, admin, {}, e)).headers.get("Location")).toBe("/admin?notice=unlinked");
    expect((await selfBody(orphan, e)).status).toBe("revoked");
    // Not for non-admins.
    expect((await post(`/admin/robots/${fine.robotId}/unlink`, kept, {}, e)).status).toBe(404);
  });
});
