import { describe, expect, it } from "vitest";
import { assertion, call, newRobot, testEnv } from "./helpers";
import { nowSeconds } from "../src/util";

describe("registration rate limit", () => {
  it("caps new unclaimed robots per hour but still lets known robots re-register", async () => {
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM robots WHERE status = 'unclaimed' AND created_at > ?")
      .bind(nowSeconds() - 3600)
      .first<{ n: number }>();
    const env = { ...testEnv, MAX_NEW_ROBOTS_PER_HOUR: String((row?.n ?? 0) + 1) };
    const reg = async (robot: Awaited<ReturnType<typeof newRobot>>) =>
      call("/v1/robots/register", {
        method: "POST",
        headers: { Authorization: await assertion(robot, "POST", "/v1/robots/register"), "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: robot.publicKey }),
      }, env);

    const first = await newRobot();
    expect((await reg(first)).status).toBe(200);
    const second = await newRobot();
    const limited = await reg(second);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await reg(first)).status).toBe(200); // existing robot: new pairing code, not a new row
  });
});
