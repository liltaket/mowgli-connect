import type { Env } from "./env";
import { nowSeconds } from "./util";

/** At most one alert of each kind per this many seconds, so a lasting problem does not spam. */
const ALERT_GAP_SECONDS = 6 * 3600;

/**
 * Sends a short operator alert to ALERT_NTFY_URL (a secret, e.g. https://ntfy.sh/<topic>), at most
 * once per kind every ALERT_GAP_SECONDS. Alerts name the problem, never people or tokens. Never
 * throws: alerting must not break the request or job that noticed the problem.
 */
export async function alert(env: Env, kind: string, message: string): Promise<void> {
  const url = env.ALERT_NTFY_URL;
  if (!url || !url.startsWith("https://")) return;
  try {
    const now = nowSeconds();
    // Claim the slot first (atomic), so concurrent requests send one alert between them.
    const slot = await env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?3`,
    )
      .bind(`alert:${kind}`, String(now), now - ALERT_GAP_SECONDS)
      .run();
    if (slot.meta.changes !== 1) return;
    await fetch(url, {
      method: "POST",
      headers: { Title: "Mowgli Connect relay", Tags: "warning", "Content-Type": "text/plain; charset=utf-8" },
      body: message,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    console.error("alert not sent", kind, e instanceof Error ? e.message : "unknown");
  }
}

/** Cron checks: problems that do not show up in any one request. */
export async function checkHealth(env: Env): Promise<void> {
  const now = nowSeconds();
  const stuck = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM robots WHERE status = 'revoked' AND tunnel_id IS NOT NULL AND updated_at < ?",
  )
    .bind(now - 3600)
    .first<{ n: number }>();
  if ((stuck?.n ?? 0) > 0) {
    await alert(env, "cleanup_stuck", `${stuck!.n} unlinked robot(s) still have a Cloudflare tunnel after an hour. Check the Cloudflare API token and the Worker logs.`);
  }
  if (!env.TUNNEL_TOKEN_KEY) {
    const sealed = await env.DB.prepare("SELECT COUNT(*) AS n FROM robots WHERE tunnel_token LIKE 'v1.%'").first<{ n: number }>();
    if ((sealed?.n ?? 0) > 0) {
      await alert(env, "token_key_missing", `TUNNEL_TOKEN_KEY is not set, so ${sealed!.n} robot(s) cannot get their tunnel token. Set the secret again.`);
    }
  }
}
