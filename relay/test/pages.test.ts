import { describe, expect, it } from "vitest";
import { normalizePairingCode } from "../src/pairing";
import { call } from "./helpers";

describe("pages and assets", () => {
  it("serves the favicons", async () => {
    for (const [path, type] of [
      ["/favicon.ico", "image/x-icon"],
      ["/icon.svg", "image/svg+xml"],
      ["/apple-touch-icon.png", "image/png"],
    ] as const) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(type);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
    }
    const png = new Uint8Array(await (await call("/apple-touch-icon.png")).arrayBuffer());
    expect(Array.from(png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]); // "PNG"
  });

  it("links the favicons and allows only same-origin images", async () => {
    const res = await call("/");
    expect(await res.text()).toContain('<link rel="icon" href="/icon.svg"');
    expect(res.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
  });

  it("uses an example pairing code that can never be issued", async () => {
    const body = await (await call("/")).text();
    expect(normalizePairingCode("clover-hedgehog-dew")).toBeNull();
    expect(body).not.toContain("sunny-tiger-moss");
  });

  it("confirms sign-out on the start page", async () => {
    const res = await call("/?notice=signedout");
    expect(await res.text()).toContain("You are signed out of Mowgli Connect");
  });
});
