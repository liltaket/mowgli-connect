import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, base32Lower, deriveRobotId } from "../src/crypto";
import { loadRelayKey } from "../src/relayKey";
import { formatPairingCode, generatePairingCode, normalizePairingCode } from "../src/pairing";
import { testEnv } from "./helpers";

describe("robotId derivation", () => {
  it("matches the cross-check vector for publicKey = 32 x 0x01", async () => {
    const id = await deriveRobotId(new Uint8Array(32).fill(1));
    console.log(`robotId test vector: publicKey=${b64urlEncode(new Uint8Array(32).fill(1))} -> robotId=${id}`);
    // Independently computed: python3 base64.b32encode(sha256(b"\x01"*32).digest()[:10]).lower()
    expect(id).toBe("olgw5bbcyqd7w3ij");
    expect(id).toMatch(/^[a-z2-7]{16}$/);
  });

  it("is 16 chars and differs per key", async () => {
    const a = await deriveRobotId(new Uint8Array(32).fill(2));
    const b = await deriveRobotId(new Uint8Array(32).fill(3));
    expect(a).toHaveLength(16);
    expect(a).not.toBe(b);
  });

  it("base32 matches RFC 4648 vectors (lowercase, unpadded)", () => {
    const t = (s: string) => base32Lower(new TextEncoder().encode(s));
    expect(t("f")).toBe("my");
    expect(t("fo")).toBe("mzxq");
    expect(t("foobar")).toBe("mzxw6ytboi");
  });
});

describe("base64url", () => {
  it("round-trips and is strict", () => {
    const bytes = Uint8Array.from([251, 255, 0, 1, 2]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(() => b64urlDecode("AQ==")).toThrow();
    expect(() => b64urlDecode("a+b")).toThrow();
    expect(() => b64urlDecode("AR")).toThrow(); // non-canonical trailing bits
  });
});

describe("pairing codes", () => {
  it("generates three known words and accepts any case and separators", async () => {
    const { WORDS } = await import("../src/wordlist");
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[a-z]{3,5}-[a-z]{3,5}-[a-z]{3,5}$/);
      for (const w of code.split("-")) expect(WORDS).toContain(w);
      expect(normalizePairingCode(code)).toBe(code);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(195); // random, not a fixed sequence
    expect(formatPairingCode("acid-acorn-acre")).toBe("acid-acorn-acre");
    for (const spelled of ["ACID ACORN ACRE", " Acid-acorn_acre ", "acid--acorn  acre", "acid.acorn,acre"]) {
      expect(normalizePairingCode(spelled)).toBe("acid-acorn-acre");
    }
    for (const bad of ["acid-acorn", "acid-acorn-acre-acid", "acid-acorn-qqqq", "", "1234-5678-90", "ABCD-EFGH-JK"]) {
      expect(normalizePairingCode(bad)).toBeNull();
    }
  });
});

describe("relay signing key", () => {
  it("accepts a PKCS8 base64 key and derives the same public key", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const pkcs8 = btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)));
    const k = await loadRelayKey({ ...testEnv, RELAY_SIGNING_KEY: pkcs8, RELAY_KEY_ID: "kp8" });
    expect(k.kid).toBe("kp8");
    expect(k.publicKeyB64).toBe(jwk.x);
  });
});
