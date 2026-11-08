const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url (no padding, canonical encoding). Throws on anything else. */
export function b64urlDecode(s: string): Uint8Array {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) throw new Error("invalid base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (b64urlEncode(out) !== s) throw new Error("non-canonical base64url");
  return out;
}

const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_LOWER[(value << (5 - bits)) & 31];
  return out;
}

/** robotId = base32lower(SHA-256(rawPublicKey)[0..10)) -> 16 chars. */
export async function deriveRobotId(rawPublicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  return base32Lower(digest.subarray(0, 10));
}

export class JwsError extends Error {}

export interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  const v: unknown = JSON.parse(dec.decode(bytes));
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
  return v as Record<string, unknown>;
}

export function parseJws(token: string): ParsedJws {
  if (token.length > 4096) throw new JwsError("token too large");
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwsError("malformed jws");
  const [h, p, s] = parts as [string, string, string];
  try {
    const signature = b64urlDecode(s);
    if (signature.length !== 64) throw new Error("bad signature length");
    return {
      header: parseJsonObject(b64urlDecode(h)),
      payload: parseJsonObject(b64urlDecode(p)),
      signingInput: enc.encode(`${h}.${p}`),
      signature,
    };
  } catch {
    throw new JwsError("malformed jws");
  }
}

export async function importEd25519Public(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("public key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

export async function verifyJws(parsed: ParsedJws, key: CryptoKey): Promise<boolean> {
  return crypto.subtle.verify({ name: "Ed25519" }, key, parsed.signature, parsed.signingInput);
}

export async function signJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: CryptoKey,
): Promise<string> {
  const input = `${b64urlEncode(enc.encode(JSON.stringify(header)))}.${b64urlEncode(enc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(input)));
  return `${input}.${b64urlEncode(sig)}`;
}
