import { describe, expect, it } from "vitest";
import { newUser, post, register, newRobot, self, testEnv } from "./helpers";
import { robotSubdomain } from "../src/provisioner";

interface SelfBody {
  hostname: string | null;
}

async function claimWith(label: string | null) {
  const robot = await newRobot();
  const { pairingCode } = (await (await register(robot, "kuffe-sim")).json()) as { pairingCode: string };
  const user = await newUser();
  const form: Record<string, string> = { code: pairingCode };
  if (label !== null) form.label = label;
  expect((await post("/claim", user, form)).status).toBe(303);
  return { robot, hostname: ((await (await self(robot)).json()) as SelfBody).hostname };
}

describe("readable robot hostnames", () => {
  it("derives a DNS label from a name", () => {
    expect(robotSubdomain("Front lawn")).toBe("front-lawn");
    expect(robotSubdomain("Gräsklippare Åsa!")).toBe("grasklippare-asa");
    expect(robotSubdomain("  --Kuffe--  ")).toBe("kuffe");
    expect(robotSubdomain("x".repeat(40))).toBe("x".repeat(32));
    expect(robotSubdomain("xn--abc")).toBe("xn-abc"); // dashes collapse, so never punycode
    for (const bad of ["ab", "www", "Login", "connect", "Hedgehog", "example", "abcdefghijklmnop", "!!!", "", null]) {
      expect(robotSubdomain(bad)).toBeNull();
    }
  });

  it("uses the owner's label, else the robot's name, numbers taken names, and falls back to the robot id", async () => {
    const a = await claimWith("Back yard");
    expect(a.hostname).toBe("back-yard.robots.test");
    const b = await claimWith("Back yard"); // taken: the next free number
    expect(b.hostname).toBe("back-yard-2.robots.test");
    for (let n = 3; n <= 9; n++) expect((await claimWith("Back yard")).hostname).toBe(`back-yard-${n}.robots.test`);
    const full = await claimWith("Back yard"); // all numbered names taken
    expect(full.hostname).toBe(`${full.robot.robotId}.robots.test`);
    const c = await claimWith("admin"); // reserved
    expect(c.hostname).toBe(`${c.robot.robotId}.robots.test`);
    const d = await claimWith(null); // robot's reported name
    expect(d.hostname).toBe("kuffe-sim.robots.test");
  });
});

describe("readable hostname used elsewhere in the zone", () => {
  it("tries the numbered names, then the robot id, instead of touching the other record", async () => {
    const { claimRobot } = await import("../src/claim");
    const { HostnameInUseError, robotHostname } = await import("../src/provisioner");
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "garden shed")).json()) as { pairingCode: string };
    const user = await newUser();
    const labels: (string | undefined)[] = [];
    const stub = {
      assignsHostnames: true,
      async provision(robotId: string, label?: string) {
        labels.push(label);
        if (label) throw new HostnameInUseError("taken");
        return { hostname: robotHostname(robotId, "robots.test"), tunnelId: "t", dnsRecordId: "d", token: "tok" };
      },
      async deprovision() {},
    };
    const res = await claimRobot(testEnv, stub, user.id, pairingCode, null);
    expect(res.ok).toBe(true);
    expect(labels).toEqual(["garden-shed", ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `garden-shed-${n}`), undefined]);
    expect(((await (await self(robot)).json()) as SelfBody).hostname).toBe(`${robot.robotId}.robots.test`);
  });
});

describe("agent info header", () => {
  it("parses only the exact format", async () => {
    const { parseAgentHeader } = await import("../src/robotApi");
    expect(parseAgentHeader("version=a7030e0; teleop=off")).toEqual({ version: "a7030e0", teleop: 0 });
    expect(parseAgentHeader("version=1.2.3+x; teleop=on")).toEqual({ version: "1.2.3+x", teleop: 1 });
    for (const bad of [null, "", "version=<b>; teleop=on", "version=1; teleop=yes", "teleop=on", "version=1; teleop=on; x=1"]) {
      expect(parseAgentHeader(bad)).toBeNull();
    }
  });

  it("is shown on the owner's dashboard", async () => {
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "joy test")).json()) as { pairingCode: string };
    const user = await newUser();
    expect((await post("/claim", user, { code: pairingCode })).status).toBe(303);
    const { assertion, call } = await import("./helpers");
    const res = await call("/v1/robots/self", {
      headers: { Authorization: await assertion(robot, "GET", "/v1/robots/self"), "MC-Agent": "version=t1; teleop=on" },
    });
    expect(res.status).toBe(200);
    const dash = await (await call("/", { headers: { Cookie: user.cookie } })).text();
    expect(dash).toContain("Remote joystick on");
  });
});

describe("robot connection status", () => {
  it("does not send the browser to a robot whose tunnel is down, and shows it offline", async () => {
    const { claimRobot } = await import("../src/claim");
    const { FakeProvisioner } = await import("../src/provisioner");
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "offline bot")).json()) as { pairingCode: string };
    const user = await newUser();
    const fake = new FakeProvisioner("robots.test");
    expect((await claimRobot(testEnv, fake, user.id, pairingCode, null)).ok).toBe(true);
    // The relay builds its own FakeProvisioner per request; mark tunnels offline through it.
    const proto = FakeProvisioner.prototype as unknown as { connected: (id: string) => Promise<boolean> };
    const original = proto.connected;
    proto.connected = async () => false;
    try {
      const { get, call } = await import("./helpers");
      const res = await get(`/open/${robot.robotId}`, user);
      expect(res.status).toBe(503);
      expect(res.headers.get("Refresh")).toBe("5");
      expect(await res.text()).toContain("Setting up your robot's connection"); // just added: normal
      expect(await (await call("/", { headers: { Cookie: user.cookie } })).text()).toContain("Setting up connection");
    } finally {
      proto.connected = original;
    }
    const { get, call } = await import("./helpers");
    expect((await get(`/open/${robot.robotId}`, user)).status).toBe(302); // online: recorded as first online
    proto.connected = async () => false;
    try {
      const later = await get(`/open/${robot.robotId}`, user);
      expect(await later.text()).toContain("Your robot is offline");
      expect(await (await call("/", { headers: { Cookie: user.cookie } })).text()).toContain("Offline");
    } finally {
      proto.connected = original;
    }
  });
});

describe("robots added long ago", () => {
  it("show Offline, not Setting up, when they have never been recorded online", async () => {
    const { claimRobot } = await import("../src/claim");
    const { FakeProvisioner } = await import("../src/provisioner");
    const robot = await newRobot();
    const { pairingCode } = (await (await register(robot, "old bot")).json()) as { pairingCode: string };
    const user = await newUser();
    expect((await claimRobot(testEnv, new FakeProvisioner("robots.test"), user.id, pairingCode, null)).ok).toBe(true);
    await testEnv.DB.prepare("UPDATE robots SET claimed_at = claimed_at - 3600, first_online_at = NULL WHERE robot_id = ?").bind(robot.robotId).run();
    const proto = FakeProvisioner.prototype as unknown as { connected: (id: string) => Promise<boolean> };
    const original = proto.connected;
    proto.connected = async () => false;
    try {
      const { get, call } = await import("./helpers");
      const dash = await (await call("/", { headers: { Cookie: user.cookie } })).text();
      expect(dash).toContain("Offline");
      expect(dash).not.toContain("Setting up connection");
      expect(await (await get(`/open/${robot.robotId}`, user)).text()).toContain("Still waiting for your robot");
    } finally {
      proto.connected = original;
    }
  });
});

describe("released hostnames (review 10)", () => {
  it("rest for 90 days before another robot can take them; the same robot can take its name back", async () => {
    const { post, newUser, newRobot, register, self, testEnv } = await import("./helpers");
    const owner = await newUser();
    const first = await newRobot();
    const c1 = ((await (await register(first, "quarantine-test")).json()) as { pairingCode: string }).pairingCode;
    expect((await post("/claim", owner, { code: c1 })).status).toBe(303);
    expect(((await (await self(first)).json()) as SelfBody).hostname).toBe("quarantine-test.robots.test");
    expect((await post(`/robots/${first.robotId}/unlink`, owner, {})).status).toBe(303);
    const rel = await testEnv.DB.prepare("SELECT robot_id FROM released_hostnames WHERE hostname = 'quarantine-test.robots.test'").first();
    expect(rel).toEqual({ robot_id: first.robotId });

    // Another robot asking for the same name gets the next one, and the preview says so.
    const other = await newRobot();
    const c2 = ((await (await register(other, "quarantine-test")).json()) as { pairingCode: string }).pairingCode;
    const u2 = await newUser();
    expect(await (await post("/claim", u2, { code: c2, step: "preview" })).text()).toContain("quarantine-test-2.robots.test");
    expect((await post("/claim", u2, { code: c2 })).status).toBe(303);
    expect(((await (await self(other)).json()) as SelfBody).hostname).toBe("quarantine-test-2.robots.test");

    // After 90 days it is free again.
    await testEnv.DB.prepare("UPDATE released_hostnames SET released_at = released_at - 91 * 86400 WHERE hostname = 'quarantine-test.robots.test'").run();
    const third = await newRobot();
    const c3 = ((await (await register(third, "quarantine-test")).json()) as { pairingCode: string }).pairingCode;
    expect((await post("/claim", await newUser(), { code: c3 })).status).toBe(303);
    expect(((await (await self(third)).json()) as SelfBody).hostname).toBe("quarantine-test.robots.test");
  });
});
