import { describe, expect, it } from "vitest";
import { b64urlDecode } from "../src/crypto";
import { importEd25519Public, parseJws, verifyJws } from "../src/crypto";
import { CLAIM_FAILURES_PER_HOUR } from "../src/claim";
import { call, decodeJws, get, newRobot, newUser, ORIGIN, post, register, registerAndClaim, self, testEnv, agePairingCode } from "./helpers";
import { nowSeconds } from "../src/util";

interface SelfBody {
  robotId: string;
  status: string;
  hostname: string | null;
  tunnelToken: string | null;
  relayKeys: { kid: string; publicKey: string }[];
  sessionEpoch: number;
  members: { userId: string; role: string }[];
}

describe("register -> claim -> self", () => {
  it("walks the whole flow with the FakeProvisioner", async () => {
    const robot = await newRobot();
    const regBody = (await (await register(robot, "Garden mower")).json()) as { pairingCode: string };

    const before = (await (await self(robot)).json()) as SelfBody;
    expect(before).toMatchObject({ robotId: robot.robotId, status: "unclaimed", hostname: null, tunnelToken: null, members: [] });
    expect(before.sessionEpoch).toBe(1);
    expect(before.relayKeys).toHaveLength(1);
    expect(before.relayKeys[0]!.kid).toBe("test-k1");

    const user = await newUser();
    // GET never claims.
    const confirm = await get(`/claim?code=${regBody.pairingCode}`, user);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain(robot.robotId);
    expect(((await (await self(robot)).json()) as SelfBody).status).toBe("unclaimed");

    const res = await post("/claim", user, { code: regBody.pairingCode.toLowerCase().replace(/-/g, " "), label: "Front lawn" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/?notice=claimed");

    const after = (await (await self(robot)).json()) as SelfBody;
    expect(after.status).toBe("claimed");
    expect(after.hostname).toBe("front-lawn.robots.test"); // readable name from the owner's label
    expect(after.tunnelToken).toBe(`fake-tunnel-token-${robot.robotId}`);
    expect(after.members).toEqual([{ userId: user.id, role: "owner" }]);
    expect(after.sessionEpoch).toBe(2);

    // Claimed robots can only use /self.
    const again = await register(robot);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_claimed" });

    const dash = await (await get("/", user)).text();
    expect(dash).toContain("Front lawn");
    expect(dash).toContain(`/open/${robot.robotId}`);
  });

  it("re-register invalidates the previous pairing code", async () => {
    const robot = await newRobot();
    const first = (await (await register(robot)).json()) as { pairingCode: string };
    const tooSoon = await register(robot);
    expect(tooSoon.status).toBe(429);
    const jtis = async () => (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM jti_seen WHERE robot_id = ?").bind(robot.robotId).first<{ n: number }>())!.n;
    const before = await jtis();
    expect((await register(robot)).status).toBe(429);
    expect(await jtis()).toBe(before); // refused without writing
    await agePairingCode(robot.robotId);
    const second = (await (await register(robot)).json()) as { pairingCode: string };
    expect(second.pairingCode).not.toBe(first.pairingCode);
    const user = await newUser();
    expect((await post("/claim", user, { code: first.pairingCode })).status).toBe(400);
    expect((await post("/claim", user, { code: second.pairingCode })).status).toBe(303);
  });

  it("rejects bad register bodies", async () => {
    const robot = await newRobot();
    const res = await register(robot, "x".repeat(65));
    expect(res.status).toBe(400);
  });
});

describe("pairing code lifecycle", () => {
  it("is single use", async () => {
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const a = await newUser();
    const b = await newUser();
    expect((await post("/claim", a, { code: pairingCode })).status).toBe(303);
    const second = await post("/claim", b, { code: pairingCode });
    expect(second.status).toBe(400);
    const members = await testEnv.DB.prepare("SELECT user_id FROM members WHERE robot_id = ?").bind(robot.robotId).all();
    expect(members.results).toHaveLength(1);
  });

  it("expires after 15 minutes", async () => {
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    await testEnv.DB.prepare("UPDATE pairing_codes SET expires_at = ? WHERE robot_id = ?").bind(nowSeconds() - 1, robot.robotId).run();
    const user = await newUser();
    expect((await post("/claim", user, { code: pairingCode })).status).toBe(400);
    expect(((await (await self(robot)).json()) as SelfBody).status).toBe("unclaimed");
  });

  it("stores only a hash of the code", async () => {
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const rows = await testEnv.DB.prepare("SELECT code_hash FROM pairing_codes WHERE robot_id = ?").bind(robot.robotId).all<{ code_hash: string }>();
    expect(rows.results[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows.results)).not.toContain(pairingCode.replaceAll("-", ""));
  });

  it(`rate-limits after ${CLAIM_FAILURES_PER_HOUR} failures per user, even for a valid code`, async () => {
    const user = await newUser();
    for (let i = 0; i < CLAIM_FAILURES_PER_HOUR; i++) {
      expect((await post("/claim", user, { code: "0000-0000-00" })).status).toBe(400);
    }
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const blocked = await post("/claim", user, { code: pairingCode });
    expect(blocked.status).toBe(429);
    // Another user is unaffected.
    expect((await post("/claim", await newUser(), { code: pairingCode })).status).toBe(303);
  });
});

describe("browser CSRF / Origin checks", () => {
  it("rejects POST /claim without or with a foreign Origin, and does not claim", async () => {
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const user = await newUser();
    expect((await post("/claim", user, { code: pairingCode }, null)).status).toBe(403);
    expect((await post("/claim", user, { code: pairingCode }, "https://evil.example")).status).toBe(403);
    expect((await post("/claim", user, { code: pairingCode }, `https://${robot.robotId}.robots.test`)).status).toBe(403);
    expect(((await (await self(robot)).json()) as SelfBody).status).toBe("unclaimed");
    expect((await post("/claim", user, { code: pairingCode })).status).toBe(303);
  });

  it("applies to logout, unlink and sessions/revoke too", async () => {
    const user = await newUser();
    const { robot } = await registerAndClaim(user);
    for (const path of ["/logout", `/robots/${robot.robotId}/unlink`, `/robots/${robot.robotId}/sessions/revoke`]) {
      expect((await post(path, user, {}, "https://evil.example")).status).toBe(403);
      expect((await post(path, user, {}, null)).status).toBe(403);
    }
    expect(((await (await self(robot)).json()) as SelfBody).status).toBe("claimed");
  });

  it("accepts Origin: null only with Sec-Fetch-Site: same-origin (form POST under a strict referrer policy)", async () => {
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot)).json()) as { pairingCode: string };
    const user = await newUser();
    for (const site of ["cross-site", "same-site", "none"]) {
      expect((await post("/claim", user, { code: pairingCode }, "null", site)).status).toBe(403);
    }
    expect((await post("/claim", user, { code: pairingCode }, "https://evil.example", "same-origin")).status).toBe(403);
    expect((await post("/claim", user, { code: pairingCode }, "null", "same-origin")).status).toBe(303);
  });

  it("requires login for POST /claim", async () => {
    const res = await post("/claim", null, { code: "ABCD-EFGH-JK" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
  });
});

describe("/open and grants", () => {
  it("mints a short-lived grant for a member and redirects to the robot callback", async () => {
    const owner = await newUser("alice");
    const { robot } = await registerAndClaim(owner);
    const s = (await (await self(robot)).json()) as SelfBody;

    const res = await get(`/open/${robot.robotId}`, owner);
    expect(res.status).toBe(302);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const loc = res.headers.get("Location")!;
    expect(loc.startsWith(`https://${robot.robotId}.robots.test/_connect/callback#grant=`)).toBe(true);

    const grant = loc.split("#grant=")[1]!;
    const { header, payload } = decodeJws(grant);
    expect(header).toEqual({ alg: "EdDSA", typ: "mc-grant+jwt", kid: "test-k1" });
    expect(payload.iss).toBe(ORIGIN);
    expect(payload.aud).toBe(`mc-robot:${robot.robotId}`);
    expect(payload.sub).toBe(owner.id);
    expect(payload.role).toBe("owner");
    expect(payload.epoch).toBe(s.sessionEpoch);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(60);
    expect(payload.exp - payload.iat).toBeGreaterThan(0);
    expect(payload.jti.length).toBeGreaterThanOrEqual(22);

    // Signature verifies with the key published via /self.
    const pub = await importEd25519Public(b64urlDecode(s.relayKeys[0]!.publicKey));
    expect(await verifyJws(parseJws(grant), pub)).toBe(true);

    // Each grant has a fresh jti.
    const again = (await get(`/open/${robot.robotId}`, owner)).headers.get("Location")!.split("#grant=")[1]!;
    expect(decodeJws(again).payload.jti).not.toBe(payload.jti);
  });

  it("a non-member cannot open another user's robot (404, no grant)", async () => {
    const owner = await newUser();
    const { robot } = await registerAndClaim(owner);
    const intruder = await newUser();
    const res = await get(`/open/${robot.robotId}`, intruder);
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
    // Same answer as for a robot that does not exist.
    expect((await get(`/open/${(await newRobot()).robotId}`, intruder)).status).toBe(404);
  });

  it("unauthenticated /open goes to login and returns afterwards", async () => {
    const res = await get("/open/abcdefghijklmnop", null);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?return_to=%2Fopen%2Fabcdefghijklmnop");
  });

  it("viewer role is carried in the grant", async () => {
    const owner = await newUser();
    const viewer = await newUser();
    const { robot } = await registerAndClaim(owner);
    await testEnv.DB.prepare("INSERT INTO members (robot_id, user_id, role, created_at) VALUES (?, ?, 'viewer', ?)")
      .bind(robot.robotId, viewer.id, nowSeconds())
      .run();
    const loc = (await get(`/open/${robot.robotId}`, viewer)).headers.get("Location")!;
    expect(decodeJws(loc.split("#grant=")[1]!).payload.role).toBe("viewer");
    const members = ((await (await self(robot)).json()) as SelfBody).members;
    expect(members.map((m) => m.role).sort()).toEqual(["owner", "viewer"]);
    // Viewers cannot unlink or revoke sessions.
    expect((await post(`/robots/${robot.robotId}/unlink`, viewer, {})).status).toBe(404);
    expect((await post(`/robots/${robot.robotId}/sessions/revoke`, viewer, {})).status).toBe(404);
  });
});

describe("owner actions", () => {
  it("sessions/revoke bumps the epoch; old grants carry the old epoch", async () => {
    const owner = await newUser();
    const { robot } = await registerAndClaim(owner);
    const e1 = ((await (await self(robot)).json()) as SelfBody).sessionEpoch;
    const g1 = decodeJws((await get(`/open/${robot.robotId}`, owner)).headers.get("Location")!.split("#grant=")[1]!);
    const res = await post(`/robots/${robot.robotId}/sessions/revoke`, owner, {});
    expect(res.status).toBe(303);
    const e2 = ((await (await self(robot)).json()) as SelfBody).sessionEpoch;
    expect(e2).toBe(e1 + 1);
    expect(g1.payload.epoch).toBe(e1);
    const g2 = decodeJws((await get(`/open/${robot.robotId}`, owner)).headers.get("Location")!.split("#grant=")[1]!);
    expect(g2.payload.epoch).toBe(e2);
  });

  it("unlink revokes the robot, drops members/token, bumps the epoch, and blocks /open", async () => {
    const owner = await newUser();
    const { robot } = await registerAndClaim(owner);
    const e1 = ((await (await self(robot)).json()) as SelfBody).sessionEpoch;
    const res = await post(`/robots/${robot.robotId}/unlink`, owner, {});
    expect(res.status).toBe(303);
    const s = (await (await self(robot)).json()) as SelfBody;
    expect(s).toMatchObject({ status: "revoked", hostname: null, tunnelToken: null, members: [] });
    expect(s.sessionEpoch).toBe(e1 + 1);
    expect((await get(`/open/${robot.robotId}`, owner)).status).toBe(404);
    const row = await testEnv.DB.prepare("SELECT tunnel_token, tunnel_id FROM robots WHERE robot_id = ?").bind(robot.robotId).first<{ tunnel_token: string | null; tunnel_id: string | null }>();
    expect(row!.tunnel_token).toBeNull();
    expect(row!.tunnel_id).toBeNull(); // FakeProvisioner cleanup succeeded
    // A revoked robot may pair again.
    expect((await register(robot)).status).toBe(200);
  });

  it("a non-owner cannot unlink someone else's robot", async () => {
    const owner = await newUser();
    const { robot } = await registerAndClaim(owner);
    const intruder = await newUser();
    expect((await post(`/robots/${robot.robotId}/unlink`, intruder, {})).status).toBe(404);
    expect(((await (await self(robot)).json()) as SelfBody).status).toBe("claimed");
  });
});

describe("sessions and allowlist", () => {
  it("stores only the SHA-256 of the session token and logout destroys it", async () => {
    const user = await newUser();
    const token = user.cookie.split("=")[1]!;
    const rows = await testEnv.DB.prepare("SELECT token_hash FROM sessions WHERE user_id = ?").bind(user.id).all<{ token_hash: string }>();
    expect(rows.results[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.results[0]!.token_hash).not.toBe(token);
    const out = await post("/logout", user, {});
    expect(out.status).toBe(303);
    expect(out.headers.get("Set-Cookie")).toContain("__Host-mcr_session=;");
    expect((await get("/", user)).status).toBe(200);
    expect(await (await get("/", user)).text()).toContain("Sign in with GitHub");
  });

  it("an empty ALLOWED_GITHUB_LOGINS admits nobody (fail closed); * admits everyone", async () => {
    const user = await newUser("someone");
    const res = await call("/", { headers: { Cookie: user.cookie } }, { ...testEnv, ALLOWED_GITHUB_LOGINS: "" });
    expect(await res.text()).toContain("Sign in with GitHub");
    const open = await call("/", { headers: { Cookie: user.cookie } }, { ...testEnv, ALLOWED_GITHUB_LOGINS: "*" });
    expect(await open.text()).toContain("Signed in as");
  });

  it("ALLOWED_GITHUB_LOGINS blocks sessions of users that are not listed", async () => {
    const allowed = await newUser("Alice-Dev");
    const other = await newUser("mallory");
    const e = { ...testEnv, ALLOWED_GITHUB_LOGINS: "alice-dev, gh:424242" };
    const ok = await call("/", { headers: { Cookie: allowed.cookie } }, e);
    expect(await ok.text()).toContain("Signed in as");
    const no = await call("/", { headers: { Cookie: other.cookie } }, e);
    expect(await no.text()).toContain("Sign in with GitHub");
  });
});

describe("output hardening", () => {
  it("escapes robot-supplied names and sends a strict CSP", async () => {
    const robot = await newRobot();
    const evil = `<img src=x onerror=alert(1)>"'`;
    const { pairingCode } = (await (await register(robot, evil)).json()) as { pairingCode: string };
    const user = await newUser();
    const res = await get(`/claim?code=${pairingCode}`, user);
    const body = await res.text();
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("script-src 'self'"); // only the same-origin /pair.js
    expect(body).not.toMatch(/<script>|<script [^>]*>[^<]+<\/script>|<[^>]*\son[a-z]+=/i); // no inline script or handlers
    // No Referer leaves the relay, but same-origin POSTs keep a real Origin header.
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("returns 421 for a foreign Host", async () => {
    const res = await fetch_other();
    expect(res.status).toBe(421);
  });
});

async function fetch_other(): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch!(new Request("https://other.example/") as never, testEnv, { waitUntil() {}, passThroughOnException() {} } as never);
}
