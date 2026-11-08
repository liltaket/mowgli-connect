import type { Env } from "./env";
import { nowSeconds, parseCookies, randomToken, sha256Hex } from "./util";

export const SESSION_COOKIE = "__Host-mcr_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface SessionUser {
  id: string;
  login: string;
  name: string | null;
}

/**
 * ALLOWED_GITHUB_LOGINS: comma list of GitHub logins (case-insensitive) or `gh:<id>` entries.
 * Empty/unset = no restriction. Prefer `gh:<id>`: GitHub logins can be renamed and later re-registered.
 */
export function isUserAllowed(env: Env, userId: string, login: string): boolean {
  const list = (env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return true;
  return list.includes(login.toLowerCase()) || list.includes(userId.toLowerCase());
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken(32);
  const now = nowSeconds();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_SECONDS)
    .run();
  return token;
}

export async function getSessionUser(env: Env, request: Request): Promise<SessionUser | null> {
  const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.login, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(token), nowSeconds())
    .first<SessionUser>();
  if (!row) return null;
  if (!isUserAllowed(env, row.id, row.login)) return null; // allowlist changes take effect immediately
  return row;
}

export async function destroySession(env: Env, request: Request): Promise<void> {
  const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * CSRF check for state-changing browser requests. Browsers send `Origin: null` on form POSTs
 * under some referrer policies, so a missing/null Origin is accepted only together with the
 * browser-set (unforgeable by page script) `Sec-Fetch-Site: same-origin`.
 */
export function originOk(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (origin === env.RELAY_ORIGIN) return true;
  return (origin === null || origin === "null") && request.headers.get("Sec-Fetch-Site") === "same-origin";
}
