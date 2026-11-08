import { b64urlDecode, b64urlEncode, JwsError, parseJws } from "./crypto";
import { SKEW_SECONDS } from "./util";

/**
 * Native app devices (docs/app-api.md). A device is a P-256 key kept in the phone's Secure
 * Enclave; its id is the key's RFC 7638 thumbprint, and every API call is a short-lived ES256
 * assertion signed with it, like the robots' own assertions (assertion.ts). There is no bearer
 * token to steal.
 */

export class DeviceAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface DeviceJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding
export const DEVICE_ID = B64URL_32;

/** A P-256 public JWK with exactly the members we use, or null. */
export function parseDeviceJwk(v: unknown): DeviceJwk | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const k = v as Record<string, unknown>;
  if (k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string") return null;
  if (!B64URL_32.test(k.x) || !B64URL_32.test(k.y)) return null;
  return { kty: "EC", crv: "P-256", x: k.x, y: k.y };
}

/** RFC 7638 thumbprint: base64url SHA-256 of the required members in lexicographic order. */
export async function jwkThumbprint(k: DeviceJwk): Promise<string> {
  const canonical = `{"crv":"P-256","kty":"EC","x":"${k.x}","y":"${k.y}"}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return b64urlEncode(new Uint8Array(digest));
}

/** Imports the key for verification; throws if it is not a point on P-256. */
export function importDeviceKey(k: DeviceJwk): Promise<CryptoKey> {
  // Decoding first rejects non-canonical base64url that importKey might still accept.
  if (b64urlDecode(k.x).length !== 32 || b64urlDecode(k.y).length !== 32) throw new DeviceAuthError("bad_key");
  return crypto.subtle.importKey("jwk", { ...k, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

export interface VerifiedDeviceAssertion {
  deviceId: string;
  jti: string;
  exp: number;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Verifies `Authorization: MC-Device <jws>`. `resolveKey` returns the device's key for an
 * issuer (null if unknown). Does NOT consume the jti.
 */
export async function verifyDeviceAssertion(o: {
  authorization: string | null;
  method: string;
  htu: string;
  aud: string;
  now: number;
  resolveKey: (iss: string) => Promise<DeviceJwk | null>;
}): Promise<VerifiedDeviceAssertion> {
  const m = /^MC-Device ([^\s]+)$/.exec(o.authorization ?? "");
  if (!m) throw new DeviceAuthError("missing_assertion");
  let parsed;
  try {
    parsed = parseJws(m[1]!);
  } catch (e) {
    throw new DeviceAuthError(e instanceof JwsError ? "malformed" : "malformed");
  }
  if (parsed.header.alg !== "ES256" || parsed.header.typ !== "mc-device+jwt") throw new DeviceAuthError("bad_header");
  const c = parsed.payload;
  if (typeof c.iss !== "string" || !DEVICE_ID.test(c.iss)) throw new DeviceAuthError("bad_iss");
  const jwk = await o.resolveKey(c.iss);
  if (!jwk) throw new DeviceAuthError("unknown_device");
  if ((await jwkThumbprint(jwk)) !== c.iss) throw new DeviceAuthError("iss_key_mismatch");
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importDeviceKey(jwk), parsed.signature, parsed.signingInput);
  } catch {
    ok = false;
  }
  if (!ok) throw new DeviceAuthError("bad_signature");
  if (c.aud !== o.aud) throw new DeviceAuthError("bad_aud");
  if (c.htm !== o.method.toUpperCase()) throw new DeviceAuthError("bad_htm");
  if (c.htu !== o.htu) throw new DeviceAuthError("bad_htu");
  if (!isInt(c.iat) || !isInt(c.exp)) throw new DeviceAuthError("bad_times");
  if (c.exp <= c.iat || c.exp - c.iat > 60) throw new DeviceAuthError("bad_lifetime");
  if (c.iat > o.now + SKEW_SECONDS) throw new DeviceAuthError("iat_in_future");
  if (c.exp + SKEW_SECONDS < o.now) throw new DeviceAuthError("expired");
  if (typeof c.jti !== "string" || c.jti.length < 22 || c.jti.length > 128) throw new DeviceAuthError("bad_jti");
  return { deviceId: c.iss, jti: c.jti, exp: c.exp };
}
