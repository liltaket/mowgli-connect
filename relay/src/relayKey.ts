import type { Env } from "./env";
import { b64urlDecode, b64urlEncode } from "./crypto";

export interface RelayKey {
  kid: string;
  privateKey: CryptoKey;
  publicKeyB64: string;
}

const cache = new Map<string, Promise<RelayKey>>();

function normalizeB64(s: string): Uint8Array {
  const std = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** RELAY_SIGNING_KEY is a private Ed25519 JWK (JSON) or PKCS8 DER (base64/base64url). */
async function parseKey(secret: string, kid: string): Promise<RelayKey> {
  const trimmed = secret.trim();
  let jwk: JsonWebKey;
  if (trimmed.startsWith("{")) {
    jwk = JSON.parse(trimmed) as JsonWebKey;
  } else {
    const probe = await crypto.subtle.importKey("pkcs8", normalizeB64(trimmed), { name: "Ed25519" }, true, ["sign"]);
    jwk = (await crypto.subtle.exportKey("jwk", probe)) as JsonWebKey;
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) {
    throw new Error("RELAY_SIGNING_KEY must be an Ed25519 private key with d and x");
  }
  if (b64urlDecode(jwk.x).length !== 32) throw new Error("RELAY_SIGNING_KEY: bad public key");
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return { kid, privateKey, publicKeyB64: b64urlEncode(b64urlDecode(jwk.x)) };
}

export function loadRelayKey(env: Env): Promise<RelayKey> {
  if (!env.RELAY_SIGNING_KEY || !env.RELAY_KEY_ID) throw new Error("RELAY_SIGNING_KEY / RELAY_KEY_ID not configured");
  const id = `${env.RELAY_KEY_ID}\n${env.RELAY_SIGNING_KEY}`;
  let p = cache.get(id);
  if (!p) {
    p = parseKey(env.RELAY_SIGNING_KEY, env.RELAY_KEY_ID);
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
