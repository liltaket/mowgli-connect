import { b64urlDecode } from "./crypto";
import type { Env } from "./env";
import { sha256Hex } from "./util";
import { WORDS } from "./wordlist";

export const PAIRING_TTL_SECONDS = 15 * 60;
export const PAIRING_WORDS = 3;

const WORD_SET = new Set(WORDS);

/**
 * Three random words from the 1,295-word list, e.g. "lemon-otter-crisp": about 31 bits, easy to
 * read aloud and type on a phone. Enough because a code lives 15 minutes, works once, and claim
 * attempts are limited per account (CLAIM_FAILURES_PER_HOUR). Words are drawn without modulo
 * bias (rejection sampling on 16-bit values).
 */
export function generatePairingCode(): string {
  const limit = 65536 - (65536 % WORDS.length);
  const out: string[] = [];
  while (out.length < PAIRING_WORDS) {
    const [n] = crypto.getRandomValues(new Uint16Array(1));
    if (n! < limit) out.push(WORDS[n! % WORDS.length]!);
  }
  return out.join("-");
}

/** Codes are stored and shown in their canonical form already ("word-word-word"). */
export function formatPairingCode(code: string): string {
  return code;
}

/**
 * Accepts any case and any separators ("Lemon Otter-crisp", "lemon_otter crisp"). Returns the
 * canonical "lemon-otter-crisp", or null unless it is exactly three known words.
 */
export function normalizePairingCode(input: string): string | null {
  const words = input.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length !== PAIRING_WORDS || !words.every((w) => WORD_SET.has(w))) return null;
  return words.join("-");
}

/**
 * The stored form of a code. With TUNNEL_TOKEN_KEY set it is an HMAC under a key derived from
 * it, so a copy of the database is not enough to recover live codes by trying all ~2^31 of them
 * (security review 10); without the key, a plain SHA-256 as before.
 */
export async function hashPairingCode(env: Env, normalized: string): Promise<string> {
  const key = await pairingKey(env);
  if (!key) return legacyHash(normalized);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalized));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Both forms a live code may be stored in (codes issued before the key existed live 15 min). */
export async function pairingCodeHashes(env: Env, normalized: string): Promise<[string, string]> {
  return [await hashPairingCode(env, normalized), await legacyHash(normalized)];
}

function legacyHash(normalized: string): Promise<string> {
  return sha256Hex(`mc-pairing-code:${normalized}`);
}

const pairingKeys = new Map<string, Promise<CryptoKey>>();

function pairingKey(env: Env): Promise<CryptoKey> | null {
  const raw = env.TUNNEL_TOKEN_KEY;
  if (!raw) return null;
  let k = pairingKeys.get(raw);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey("raw", b64urlDecode(raw.trim()), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("mc-pairing-code-hmac") },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
    })();
    pairingKeys.set(raw, k);
  }
  return k;
}
