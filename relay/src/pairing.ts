import { sha256Hex } from "./util";

// Crockford base32 alphabet (no I, L, O, U).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_TTL_SECONDS = 15 * 60;

/** 10 chars = 50 bits. 256 % 32 == 0 so `byte & 31` is unbiased. */
export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** Case-insensitive, ignores '-' and whitespace; Crockford O->0, I/L->1. Returns null if invalid. */
export function normalizePairingCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== 10) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export function hashPairingCode(normalized: string): Promise<string> {
  return sha256Hex(`mc-pairing-code:${normalized}`);
}
