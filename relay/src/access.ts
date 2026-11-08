import type { Env } from "./env";

/** Robots a person may own unless the admin sets another limit for them. */
export const DEFAULT_ROBOT_LIMIT = 3;
export const MAX_ROBOT_LIMIT = 100;

export const GITHUB_USER_ID = /^gh:[1-9][0-9]{0,19}$/;

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * ADMIN_GITHUB_IDS: comma list of `gh:<id>` entries. Ids only, never logins: a login can be
 * renamed and registered again by somebody else. Admins can always sign in and own any number
 * of robots.
 */
export function isAdmin(env: Env, userId: string): boolean {
  return list(env.ADMIN_GITHUB_IDS).some((id) => GITHUB_USER_ID.test(id) && id === userId.toLowerCase());
}

/**
 * Who may sign in: admins, people invited from the admin page (by id), and ALLOWED_GITHUB_LOGINS
 * (comma list of logins or `gh:<id>` entries; `*` = any GitHub account) for relays configured
 * by hand. Nothing configured = nobody (fail closed).
 */
export async function isUserAllowed(env: Env, userId: string, login: string): Promise<boolean> {
  if (isAdmin(env, userId)) return true;
  const allowed = list(env.ALLOWED_GITHUB_LOGINS);
  if (allowed.includes("*") || allowed.includes(login.toLowerCase()) || allowed.includes(userId.toLowerCase())) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM invites WHERE user_id = ?").bind(userId).first();
  return row !== null;
}

export async function defaultRobotLimit(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'default_robot_limit'").first<{ value: string }>();
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_ROBOT_LIMIT ? n : DEFAULT_ROBOT_LIMIT;
}

/** How many robots this person may own; null = no limit (admins). */
export async function robotLimit(env: Env, userId: string): Promise<number | null> {
  if (isAdmin(env, userId)) return null;
  const row = await env.DB.prepare("SELECT robot_limit FROM invites WHERE user_id = ?").bind(userId).first<{ robot_limit: number | null }>();
  return row?.robot_limit ?? (await defaultRobotLimit(env));
}

export async function ownedRobots(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM members m JOIN robots r ON r.robot_id = m.robot_id
     WHERE m.user_id = ? AND m.role = 'owner' AND r.status = 'claimed'`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Parses a robot limit typed on the admin page: a whole number from 0 to MAX_ROBOT_LIMIT. */
export function parseRobotLimit(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,3}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n <= MAX_ROBOT_LIMIT ? n : null;
}
