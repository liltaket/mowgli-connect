import { describe, expect, it } from "vitest";
import { assertion, call, newRobot, testEnv } from "./helpers";
import { nowSeconds, readBodyText } from "../src/util";

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
    const jtis = async () => (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM jti_seen").first<{ n: number }>())!.n;
    const before = await jtis();
    const limited = await reg(second);
    expect(limited.status).toBe(429);
    expect(await jtis()).toBe(before); // refused before anything is written
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await reg(first)).status).toBe(200); // existing robot: new pairing code, not a new row
  });
});

describe("request body limit", () => {
  it("stops reading a streamed body as soon as it exceeds the limit", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 100) c.close();
        else c.enqueue(new Uint8Array(1024));
      },
    });
    const req = new Request("https://relay.test/x", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(await readBodyText(req, 4096)).toBeNull();
    expect(pulled).toBeLessThan(10);
  });

  it("rejects a declared oversized body without reading it", async () => {
    const req = new Request("https://relay.test/x", { method: "POST", body: "x".repeat(5000), headers: { "Content-Length": "5000" } });
    expect(await readBodyText(req, 4096)).toBeNull();
    expect(await readBodyText(new Request("https://relay.test/x", { method: "POST", body: "{}" }), 4096)).toBe("{}");
  });
});
