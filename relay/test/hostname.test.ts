import { describe, expect, it } from "vitest";
import { newUser, post, register, newRobot, self } from "./helpers";
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
    for (const bad of ["ab", "www", "Login", "connect", "abcdefghijklmnop", "!!!", "", null]) {
      expect(robotSubdomain(bad)).toBeNull();
    }
  });

  it("uses the owner's label, else the robot's name, and falls back to the robot id when taken or reserved", async () => {
    const a = await claimWith("Back yard");
    expect(a.hostname).toBe("back-yard.robots.test");
    const b = await claimWith("Back yard"); // taken
    expect(b.hostname).toBe(`${b.robot.robotId}.robots.test`);
    const c = await claimWith("admin"); // reserved
    expect(c.hostname).toBe(`${c.robot.robotId}.robots.test`);
    const d = await claimWith(null); // robot's reported name
    expect(d.hostname).toBe("kuffe-sim.robots.test");
  });
});
