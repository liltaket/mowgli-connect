import { describe, expect, it } from "vitest";
import { agePairingCode, assertion, call, newRobot, testEnv } from "./helpers";
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
    await agePairingCode(first.robotId);
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

describe("pairing guess budget under concurrency (review 10)", () => {
  it("never allows more than ten failed guesses per hour, even all at once", async () => {
    const { newUser, post, testEnv } = await import("./helpers");
    const u = await newUser();
    const res = await Promise.all(Array.from({ length: 40 }, (_, i) => post("/claim", u, { code: `wrong-guess-${"abcdefghijklmnopqrstuvwxyzabcdefghijklmn"[i]}` })));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 400).length).toBeLessThanOrEqual(10);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(30);
    const n = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM claim_failures WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBeLessThanOrEqual(10);
  });

  it("does not count valid codes against the budget", async () => {
    const { newUser, newRobot, register, post, testEnv } = await import("./helpers");
    const u = await newUser();
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "ok")).json()) as { pairingCode: string };
    for (let i = 0; i < 12; i++) expect((await post("/claim", u, { code: pairingCode, step: "preview" })).status).toBe(200);
    const n = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM claim_failures WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe("code links from other sites (review 10)", () => {
  it("do not use the guess budget when loaded by another page", async () => {
    const { newUser, call, testEnv } = await import("./helpers");
    const u = await newUser();
    for (const site of ["same-site", "cross-site"]) {
      const res = await call("/claim?code=wrong-guess-x", { headers: { Cookie: u.cookie, "Sec-Fetch-Site": site }, redirect: "manual" });
      expect(res.status).toBe(302);
    }
    const n = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM claim_failures WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
    const typed = await call("/claim?code=wrong-guess-x", { headers: { Cookie: u.cookie, "Sec-Fetch-Site": "none" }, redirect: "manual" });
    expect(typed.status).toBe(400);
  });
});

describe("registrations per network (review 10)", () => {
  it("one network cannot use up the global hourly cap", async () => {
    const { newRobot, assertion, call } = await import("./helpers");
    const reg = async (ip: string) => {
      const robot = await newRobot();
      return call("/v1/robots/register", {
        method: "POST",
        headers: { Authorization: await assertion(robot, "POST", "/v1/robots/register"), "Content-Type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ publicKey: robot.publicKey }),
      });
    };
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await reg(`203.0.113.${10 + i}`)).status); // same /24
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
    expect((await reg("198.51.100.7")).status).toBe(200); // another network still can
    expect((await reg("2001:db8:1:2::1")).status).toBe(200);
  });
});
