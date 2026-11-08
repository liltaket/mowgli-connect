import { b64urlDecode, b64urlEncode } from "./crypto";
import type { Env } from "./env";

/**
 * Tunnel connector tokens at rest. With TUNNEL_TOKEN_KEY (a secret: 32 random bytes, base64url)
 * they are stored AES-256-GCM encrypted as "v1.<iv>.<ciphertext>", bound to their robot id, so a
 * copy of the database alone does not let anyone run a robot's tunnel, and a sealed token cannot be
 * moved to another robot's row. Without the key they are stored as before (plain text), so a
 * self-hosted relay keeps working; older plain-text rows are sealed by the cron once a key is set.
 */

const PREFIX = "v1.";
const keys = new Map<string, Promise<CryptoKey>>();

function key(env: Env): Promise<CryptoKey> | null {
  const raw = env.TUNNEL_TOKEN_KEY;
  if (!raw) return null;
  let k = keys.get(raw);
  if (!k) {
    const bytes = b64urlDecode(raw.trim());
    if (bytes.length !== 32) throw new Error("TUNNEL_TOKEN_KEY must be 32 bytes, base64url");
    k = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    keys.set(raw, k);
  }
  return k;
}

const aad = (robotId: string) => new TextEncoder().encode(`mc-tunnel-token:${robotId}`);

export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export async function sealToken(env: Env, robotId: string, token: string | null): Promise<string | null> {
  const k = key(env);
  if (token === null || !k) return token;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(robotId) }, await k, new TextEncoder().encode(token));
  return `${PREFIX}${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ct))}`;
}

/** The token, or null if it cannot be opened (no key, wrong key, or a row from another robot). */
export async function openToken(env: Env, robotId: string, stored: string | null): Promise<string | null> {
  if (stored === null) return null;
  if (!isSealed(stored)) return stored; // stored before a key was set; the cron seals it
  const k = key(env);
  if (!k) return null;
  const [iv, ct] = stored.slice(PREFIX.length).split(".");
  if (!iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(iv), additionalData: aad(robotId) }, await k, b64urlDecode(ct));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Seals plain-text tokens left from before the key was set. Returns how many were sealed. */
export async function sealStoredTokens(env: Env, limit = 50): Promise<number> {
  if (!key(env)) return 0;
  const rows = await env.DB.prepare(
    "SELECT robot_id, tunnel_token FROM robots WHERE tunnel_token IS NOT NULL AND tunnel_token NOT LIKE 'v1.%' LIMIT ?",
  )
    .bind(limit)
    .all<{ robot_id: string; tunnel_token: string }>();
  let n = 0;
  for (const r of rows.results) {
    const sealed = await sealToken(env, r.robot_id, r.tunnel_token);
    const res = await env.DB.prepare("UPDATE robots SET tunnel_token = ? WHERE robot_id = ? AND tunnel_token = ?")
      .bind(sealed, r.robot_id, r.tunnel_token)
      .run();
    n += res.meta.changes;
  }
  return n;
}
