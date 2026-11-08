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

export function hashPairingCode(normalized: string): Promise<string> {
  return sha256Hex(`mc-pairing-code:${normalized}`);
}
