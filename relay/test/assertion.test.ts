import { describe, expect, it } from "vitest";
import { call, newRobot, register, self, assertion, ORIGIN, testEnv } from "./helpers";
import { nowSeconds } from "../src/util";

async function detail(res: Response): Promise<string> {
  return ((await res.json()) as { detail?: string }).detail ?? "";
}

describe("robot assertion verification", () => {
  it("accepts a valid assertion on register", async () => {
    const robot = await newRobot();
    const res = await register(robot, "Test mower");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { robotId: string; pairingCode: string; claimUrl: string; expiresAt: number };
    expect(body.robotId).toBe(robot.robotId);
    expect(body.pairingCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{2}$/);
    expect(body.claimUrl).toBe(`${ORIGIN}/claim?code=${body.pairingCode.replaceAll("-", "")}`);
    expect(body.expiresAt - nowSeconds()).toBeGreaterThan(14 * 60);
    expect(body.expiresAt - nowSeconds()).toBeLessThanOrEqual(15 * 60);
  });

  it("rejects a wrong aud", async () => {
    const robot = await newRobot();
    const res = await register(robot, undefined, { claims: { aud: "https://evil.example" } });
    expect(res.status).toBe(401);
    expect(await detail(res)).toBe("bad_aud");
  });

  it("rejects a replayed jti", async () => {
    const robot = await newRobot();
    expect((await register(robot)).status).toBe(200);
    const auth = await assertion(robot, "GET", "/v1/robots/self");
    const first = await call("/v1/robots/self", { headers: { Authorization: auth } });
    expect(first.status).toBe(200);
    const replay = await call("/v1/robots/self", { headers: { Authorization: auth } });
    expect(replay.status).toBe(401);
    expect(await detail(replay)).toBe("replayed_jti");
  });

  it("rejects an expired assertion (beyond 30s skew)", async () => {
    const robot = await newRobot();
    const iat = nowSeconds() - 200;
    const res = await register(robot, undefined, { claims: { iat, exp: iat + 60 } });
    expect(res.status).toBe(401);
    expect(await detail(res)).toBe("expired");
  });

  it("rejects exp - iat > 60 and iat in the future", async () => {
    const robot = await newRobot();
    const iat = nowSeconds();
    expect(await detail(await register(robot, undefined, { claims: { iat, exp: iat + 61 } }))).toBe("bad_lifetime");
    expect(await detail(await register(robot, undefined, { claims: { iat: iat + 120, exp: iat + 150 } }))).toBe("iat_in_future");
  });

  it("rejects an assertion signed by the wrong key", async () => {
    const robot = await newRobot();
    const attacker = await newRobot();
    const res = await register(robot, undefined, { signWith: attacker.privateKey });
    expect(res.status).toBe(401);
    expect(await detail(res)).toBe("bad_signature");

    // Existing robot: attacker cannot call /self as it.
    expect((await register(robot)).status).toBe(200);
    const forged = await self(robot, { signWith: attacker.privateKey });
    expect(forged.status).toBe(401);
  });

  it("rejects iss that does not derive from the key", async () => {
    const robot = await newRobot();
    const other = await newRobot();
    const res = await register(robot, undefined, { claims: { iss: other.robotId } });
    expect(res.status).toBe(401);
    expect(await detail(res)).toBe("iss_key_mismatch");
  });

  it("rejects htm / htu mismatch (assertion not reusable on another endpoint)", async () => {
    const robot = await newRobot();
    expect(await detail(await register(robot, undefined, { claims: { htm: "GET" } }))).toBe("bad_htm");
    expect(await detail(await register(robot, undefined, { claims: { htu: `${ORIGIN}/v1/robots/self` } }))).toBe("bad_htu");
    expect((await register(robot)).status).toBe(200);
    const auth = await assertion(robot, "GET", "/v1/robots/register");
    const res = await call("/v1/robots/self", { headers: { Authorization: auth } });
    expect(res.status).toBe(401);
  });

  it("rejects bad header typ/alg, short jti and missing header", async () => {
    const robot = await newRobot();
    expect(await detail(await register(robot, undefined, { header: { typ: "JWT" } }))).toBe("bad_header");
    expect(await detail(await register(robot, undefined, { claims: { jti: "short" } }))).toBe("bad_jti");
    const res = await call("/v1/robots/register", { method: "POST", body: JSON.stringify({ publicKey: robot.publicKey }) });
    expect(res.status).toBe(401);
  });

  it("/self for an unknown robot is 404", async () => {
    const robot = await newRobot();
    expect((await self(robot)).status).toBe(404);
  });

  it("scheduled() removes expired jtis", async () => {
    const { createScheduledController, createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const worker = (await import("../src/index")).default;
    const robot = await newRobot();
    await testEnv.DB.prepare("INSERT INTO jti_seen (robot_id, jti, expires_at) VALUES (?, ?, ?)")
      .bind(robot.robotId, "old-jti", nowSeconds() - 10)
      .run();
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController() as never, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    const row = await testEnv.DB.prepare("SELECT 1 AS x FROM jti_seen WHERE jti = 'old-jti'").first();
    expect(row).toBeNull();
  });
});
