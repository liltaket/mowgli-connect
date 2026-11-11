import { adminIds } from "./access";
import { alert } from "./alerts";
import type { Env } from "./env";
import { nowSeconds } from "./util";

/**
 * The emergency stop. While it is on, nobody gets a new session or grant (the admin can still sign
 * in, to turn it off), and every robot is told it has no tunnel token and no members, so it
 * accepts nobody even if it is still running. Engaging it also ends everything that exists: all
 * robots' session epochs go up and every non-admin browser session is deleted, so turning it off
 * again does not bring old sessions back. The state is one row in `settings`, so it can also be set
 * from outside the relay (docs/kill-switch.md) when the admin's own sign-in is the problem.
 */

const KEY = "kill_switch";

/** When the emergency stop was engaged (unix seconds), or null while it is off. */
export async function killSwitchSince(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(KEY).first<{ value: string }>();
  const t = row ? Number(row.value) : NaN;
  return Number.isFinite(t) ? t : null;
}

export async function engageKillSwitch(env: Env, by: string): Promise<void> {
  const now = nowSeconds();
  const admins = adminIds(env);
  const keep = admins.length ? `user_id NOT IN (${admins.map(() => "?").join(", ")})` : "1 = 1";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(KEY, String(now)),
    env.DB.prepare("UPDATE robots SET session_epoch = session_epoch + 1, updated_at = ? WHERE status = 'claimed'").bind(now),
    env.DB.prepare(`DELETE FROM sessions WHERE ${keep}`).bind(...admins),
  ]);
  console.log("admin: kill switch engaged by", by);
  await alert(env, "kill_switch_on", "Emergency stop is ON: no new sessions, all robots told to accept nobody.");
}

export async function releaseKillSwitch(env: Env, by: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(KEY).run();
  console.log("admin: kill switch released by", by);
  await alert(env, "kill_switch_off", "Emergency stop is OFF: sign-in and robot access work again.");
}
