import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { createProvisioner, QuickProvisioner } from "../src/provisioner";
import { assertion, call, decodeJws, get, newRobot, newUser, post, register, self, testEnv, type TestRobot, type TestUser } from "./helpers";

const quickEnv: Env = { ...testEnv, PROVISIONER: "quick" };

interface SelfBody {
  robotId: string;
  status: string;
  hostname: string | null;
  tunnelToken: string | null;
  members: { userId: string; role: string }[];
}

async function claimQuick(user: TestUser): Promise<TestRobot> {
  const robot = await newRobot();
  const reg = (await (await register(robot)).json()) as { pairingCode: string };
  const res = await call(
    "/claim",
    {
      method: "POST",
      headers: { Cookie: user.cookie, Origin: "https://relay.test", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: reg.pairingCode }).toString(),
      redirect: "manual",
    },
    quickEnv,
  );
  expect(res.status).toBe(303);
  return robot;
}

async function report(robot: TestRobot, hostname: unknown, e = quickEnv, authz?: string): Promise<Response> {
  return call(
    "/v1/robots/hostname",
    {
      method: "POST",
      headers: { Authorization: authz ?? (await assertion(robot, "POST", "/v1/robots/hostname")), "Content-Type": "application/json" },
      body: JSON.stringify({ hostname }),
    },
    e,
  );
}

function openAs(user: TestUser, robot: TestRobot): Promise<Response> {
  return call(`/open/${robot.robotId}`, { headers: { Cookie: user.cookie }, redirect: "manual" }, quickEnv);
}

describe("quick-tunnel mode: claim", () => {
  it("claims without provisioning anything: hostname and tunnel token stay null", async () => {
    const user = await newUser();
    const robot = await claimQuick(user);
    const s = (await (await self(robot)).json()) as SelfBody;
    expect(s).toMatchObject({ status: "claimed", hostname: null, tunnelToken: null, members: [{ userId: user.id, role: "owner" }] });
    const row = await testEnv.DB.prepare("SELECT tunnel_id, dns_record_id FROM robots WHERE robot_id = ?")
      .bind(robot.robotId)
      .first<{ tunnel_id: string | null; dns_record_id: string | null }>();
    expect(row).toEqual({ tunnel_id: null, dns_record_id: null });
  });

  it("QuickProvisioner is a no-op in both directions", async () => {
    const p = new QuickProvisioner();
    expect(await p.provision("abcdefghijklmnop")).toEqual({ hostname: null, tunnelId: null, dnsRecordId: null, token: null });
    await expect(p.deprovision({ robotId: "abcdefghijklmnop", hostname: null, tunnelId: null, dnsRecordId: null })).resolves.toBeUndefined();
  });

  it("createProvisioner selects QuickProvisioner without any Cloudflare config", () => {
    expect(createProvisioner({ ...quickEnv, CF_API_TOKEN: undefined, CF_ZONE_ID: undefined })).toBeInstanceOf(QuickProvisioner);
  });

  it("dashboard shows a waiting state, then the reported hostname", async () => {
    const user = await newUser();
    const robot = await claimQuick(user);
    const dash = async () => (await (await call("/", { headers: { Cookie: user.cookie } }, quickEnv)).text());
    expect(await dash()).toContain("waiting for tunnel");
    expect((await report(robot, "calm-river-1.trycloudflare.com")).status).toBe(200);
    const after = await dash();
    expect(after).toContain("calm-river-1.trycloudflare.com");
    expect(after).not.toContain("waiting for tunnel");
  });

  it("unlink works with a null or a reported hostname and frees the hostname", async () => {
    const owner = await newUser();
    const pending = await claimQuick(owner);
    const unlink = (r: TestRobot) =>
      call(
        `/robots/${r.robotId}/unlink`,
        { method: "POST", headers: { Cookie: owner.cookie, Origin: "https://relay.test" }, redirect: "manual" },
        quickEnv,
      );
    expect((await unlink(pending)).status).toBe(303);
    expect(((await (await self(pending)).json()) as SelfBody).status).toBe("revoked");

    const live = await claimQuick(owner);
    await report(live, "freed-host.trycloudflare.com");
    expect((await unlink(live)).status).toBe(303);
    const s = (await (await self(live)).json()) as SelfBody;
    expect(s).toMatchObject({ status: "revoked", hostname: null, tunnelToken: null });
    // The hostname is released for another robot.
    const other = await claimQuick(await newUser());
    expect((await report(other, "freed-host.trycloudflare.com")).status).toBe(200);
  });
});

describe("POST /v1/robots/hostname", () => {
  it("accepts a quick-tunnel hostname and returns the /self body", async () => {
    const user = await newUser();
    const robot = await claimQuick(user);
    const before = await testEnv.DB.prepare("UPDATE robots SET last_seen_at = 1 WHERE robot_id = ?").bind(robot.robotId).run();
    expect(before.meta.changes).toBe(1);
    const res = await report(robot, "quiet-fox-123.trycloudflare.com");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SelfBody & { relayKeys: unknown[]; sessionEpoch: number };
    expect(body).toMatchObject({
      robotId: robot.robotId,
      status: "claimed",
      hostname: "quiet-fox-123.trycloudflare.com",
      tunnelToken: null,
      members: [{ userId: user.id, role: "owner" }],
    });
    expect(body.relayKeys).toHaveLength(1);
    expect(body.sessionEpoch).toBe(2);
    expect(((await (await self(robot)).json()) as SelfBody).hostname).toBe("quiet-fox-123.trycloudflare.com");
    const seen = await testEnv.DB.prepare("SELECT last_seen_at FROM robots WHERE robot_id = ?").bind(robot.robotId).first<{ last_seen_at: number }>();
    expect(seen!.last_seen_at).toBeGreaterThan(1);
  });

  it("normalizes uppercase to lowercase", async () => {
    const robot = await claimQuick(await newUser());
    const res = await report(robot, "Mixed-CASE-9.TryCloudflare.COM");
    expect(res.status).toBe(200);
    expect(((await res.json()) as SelfBody).hostname).toBe("mixed-case-9.trycloudflare.com");
  });

  it.each([
    "evil.com",
    "x.trycloudflare.com.evil.com",
    "evil.com/x.trycloudflare.com",
    "a-.trycloudflare.com",
    "-a.trycloudflare.com",
    "a--b.trycloudflare.com",
    "trycloudflare.com",
    ".trycloudflare.com",
    "sub.label.trycloudflare.com",
    "x.trycloudflare.com.",
    " x.trycloudflare.com",
    "x.trycloudflare.com\n",
    "x_y.trycloudflare.com",
    "x.trycloudflare.com:443",
    "https://x.trycloudflare.com",
    "",
    `${"a".repeat(250)}.trycloudflare.com`,
    42,
    null,
  ])("rejects %j with 400 and keeps the previous hostname", async (bad) => {
    const robot = await claimQuick(await newUser());
    const good = `good-${robot.robotId}.trycloudflare.com`;
    expect((await report(robot, good)).status).toBe(200);
    const res = await report(robot, bad);
    expect(res.status).toBe(400);
    expect(((await (await self(robot)).json()) as SelfBody).hostname).toBe(good);
  });

  it("rejects a missing or non-object body with 400", async () => {
    const robot = await claimQuick(await newUser());
    const noField = await call(
      "/v1/robots/hostname",
      { method: "POST", headers: { Authorization: await assertion(robot, "POST", "/v1/robots/hostname") }, body: "{}" },
      quickEnv,
    );
    expect(noField.status).toBe(400);
    const junk = await call(
      "/v1/robots/hostname",
      { method: "POST", headers: { Authorization: await assertion(robot, "POST", "/v1/robots/hostname") }, body: "[1]" },
      quickEnv,
    );
    expect(junk.status).toBe(400);
  });

  it("answers 409 when another robot holds the hostname, and allows the same robot to repeat it", async () => {
    const a = await claimQuick(await newUser());
    const b = await claimQuick(await newUser());
    expect((await report(a, "shared-name.trycloudflare.com")).status).toBe(200);
    const clash = await report(b, "SHARED-NAME.trycloudflare.com");
    expect(clash.status).toBe(409);
    expect(((await (await self(b)).json()) as SelfBody).hostname).toBeNull();
    expect((await report(a, "shared-name.trycloudflare.com")).status).toBe(200);
  });

  it("rejects unclaimed robots with 409 and stores nothing", async () => {
    const robot = await newRobot();
    await register(robot);
    const res = await report(robot, "early-bird.trycloudflare.com");
    expect(res.status).toBe(409);
    expect(((await (await self(robot)).json()) as SelfBody).hostname).toBeNull();
    const row = await testEnv.DB.prepare("SELECT hostname FROM robots WHERE robot_id = ?").bind(robot.robotId).first<{ hostname: string | null }>();
    expect(row!.hostname).toBeNull();
  });

  it("rejects unknown robots (404) and bad assertions (401)", async () => {
    const stranger = await newRobot();
    expect((await report(stranger, "x.trycloudflare.com")).status).toBe(404);
    const robot = await claimQuick(await newUser());
    expect((await report(robot, "x.trycloudflare.com", quickEnv, "MC-Robot not.a.jws")).status).toBe(401);
    const wrongPath = await assertion(robot, "POST", "/v1/robots/self");
    expect((await report(robot, "x.trycloudflare.com", quickEnv, wrongPath)).status).toBe(401);
    const wrongMethod = await assertion(robot, "GET", "/v1/robots/hostname");
    expect((await report(robot, "x.trycloudflare.com", quickEnv, wrongMethod)).status).toBe(401);
    const wrongAud = await assertion(robot, "POST", "/v1/robots/hostname", { claims: { aud: "https://other.example" } });
    expect((await report(robot, "x.trycloudflare.com", quickEnv, wrongAud)).status).toBe(401);
  });

  it("rejects a replayed assertion", async () => {
    const robot = await claimQuick(await newUser());
    const authz = await assertion(robot, "POST", "/v1/robots/hostname");
    expect((await report(robot, "first-use.trycloudflare.com", quickEnv, authz)).status).toBe(200);
    const replay = await report(robot, "replayed.trycloudflare.com", quickEnv, authz);
    expect(replay.status).toBe(401);
    expect(((await (await self(robot)).json()) as SelfBody).hostname).toBe("first-use.trycloudflare.com");
  });

  it("is rejected with 409 when PROVISIONER is not quick", async () => {
    const user = await newUser();
    const robot = await newRobot();
    const reg = (await (await register(robot)).json()) as { pairingCode: string };
    expect((await post("/claim", user, { code: reg.pairingCode })).status).toBe(303); // fake provisioner
    for (const e of [testEnv, { ...testEnv, PROVISIONER: "cloudflare" }, { ...testEnv, PROVISIONER: undefined }]) {
      const res = await report(robot, "x.trycloudflare.com", e);
      expect(res.status).toBe(409);
    }
    expect(((await (await self(robot)).json()) as SelfBody).hostname).toBe(`${robot.robotId}.robots.test`);
  });

  it("only allows POST", async () => {
    const res = await call("/v1/robots/hostname", { method: "GET" }, quickEnv);
    expect(res.status).toBe(405);
  });
});

describe("/open in quick-tunnel mode", () => {
  it("shows a friendly 503 page until the robot reports a hostname, then redirects to it", async () => {
    const user = await newUser("alice");
    const robot = await claimQuick(user);

    const waiting = await openAs(user, robot);
    expect(waiting.status).toBe(503);
    expect(waiting.headers.get("Location")).toBeNull();
    expect(waiting.headers.get("Retry-After")).toBeTruthy();
    expect(waiting.headers.get("Content-Type")).toContain("text/html");
    expect(await waiting.text()).toContain("starting its tunnel");

    expect((await report(robot, "Bright-Lake-7.trycloudflare.com")).status).toBe(200);
    const res = await openAs(user, robot);
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith("https://bright-lake-7.trycloudflare.com/_connect/callback#grant=")).toBe(true);
    const { payload } = decodeJws(loc.split("#grant=")[1]!);
    expect(payload.aud).toBe(`mc-robot:${robot.robotId}`);
    expect(payload.sub).toBe(user.id);
  });

  it("a restart re-reports a new hostname and /open follows the new one", async () => {
    const user = await newUser();
    const robot = await claimQuick(user);
    await report(robot, "old-host-1.trycloudflare.com");
    expect((await openAs(user, robot)).headers.get("Location")).toContain("https://old-host-1.trycloudflare.com/_connect/callback#grant=");
    expect((await report(robot, "new-host-2.trycloudflare.com")).status).toBe(200);
    expect(((await (await self(robot)).json()) as SelfBody).hostname).toBe("new-host-2.trycloudflare.com");
    const loc = (await openAs(user, robot)).headers.get("Location")!;
    expect(loc.startsWith("https://new-host-2.trycloudflare.com/_connect/callback#grant=")).toBe(true);
    expect(loc).not.toContain("old-host-1");
  });

  it("non-members still get 404, not the waiting page", async () => {
    const robot = await claimQuick(await newUser());
    expect((await openAs(await newUser(), robot)).status).toBe(404);
  });

  it("an unauthenticated /open still goes to login", async () => {
    const res = await get("/open/abcdefghijklmnop", null);
    expect(res.status).toBe(302);
  });
});
