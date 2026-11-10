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

/** ALLOWED_GITHUB_LOGINS: logins or `gh:<id>` entries, `*` = any GitHub account. */
function allowedByConfig(env: Env, userId: string, login: string): boolean {
  const allowed = list(env.ALLOWED_GITHUB_LOGINS);
  return allowed.includes("*") || allowed.includes(login.toLowerCase()) || allowed.includes(userId.toLowerCase());
}

/**
 * Who may own robots (claim them, with a robot limit): admins, people invited from the admin page
 * (by id), and ALLOWED_GITHUB_LOGINS for relays configured by hand. Nothing configured = nobody
 * (fail closed). Everyone who may own robots may sign in.
 */
export async function canOwn(env: Env, userId: string, login: string): Promise<boolean> {
  if (isAdmin(env, userId) || allowedByConfig(env, userId, login)) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM invites WHERE user_id = ?").bind(userId).first();
  return row !== null;
}

/**
 * Who may sign in: everyone who may own robots, and guests. A guest is someone a robot is shared
 * with (by GitHub id) whose owner may still own robots; they can open the robots shared with them
 * and nothing more: no robots of their own (their robot limit is 0), and they are not on the
 * admin page. Checked on every request, so a guest's last share ending signs them out at once.
 */
export async function canSignIn(env: Env, userId: string, login: string): Promise<boolean> {
  return (await canOwn(env, userId, login)) || (await hasLiveShare(env, userId));
}

/** Whether a robot is shared with this person by an owner who may still own robots. */
export async function hasLiveShare(env: Env, userId: string): Promise<boolean> {
  const owners = await env.DB.prepare(
    `SELECT DISTINCT o.user_id, u.login FROM members m
       JOIN robots r ON r.robot_id = m.robot_id AND r.status = 'claimed'
       JOIN members o ON o.robot_id = m.robot_id AND o.role = 'owner'
       JOIN users u ON u.id = o.user_id
     WHERE m.user_id = ? AND m.role != 'owner' LIMIT 20`,
  )
    .bind(userId)
    .all<{ user_id: string; login: string }>();
  for (const o of owners.results) {
    if (await canOwn(env, o.user_id, o.login)) return true;
  }
  return false;
}

export async function defaultRobotLimit(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'default_robot_limit'").first<{ value: string }>();
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_ROBOT_LIMIT ? n : DEFAULT_ROBOT_LIMIT;
}

/** How many robots this person may own; null = no limit (admins), 0 for guests. */
export async function robotLimit(env: Env, userId: string): Promise<number | null> {
  if (isAdmin(env, userId)) return null;
  const row = await env.DB.prepare("SELECT robot_limit FROM invites WHERE user_id = ?").bind(userId).first<{ robot_limit: number | null }>();
  if (row) return row.robot_limit ?? (await defaultRobotLimit(env));
  const user = await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(userId).first<{ login: string }>();
  return user && allowedByConfig(env, userId, user.login) ? await defaultRobotLimit(env) : 0;
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
