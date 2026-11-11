import type { Env } from "./env";
import { nowSeconds } from "./util";

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
  if (ownsByConfig(env, userId, login)) return true;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM invites WHERE user_id = ?").bind(userId).first();
  return mayOwn(env, userId, login, row !== null);
}

/** canOwn without the invitation: admins and ALLOWED_GITHUB_LOGINS. */
function ownsByConfig(env: Env, userId: string, login: string): boolean {
  return isAdmin(env, userId) || allowedByConfig(env, userId, login);
}

/** canOwn once the invitation is known; the one definition, for owners and for the people they share with. */
function mayOwn(env: Env, userId: string, login: string, invited: boolean): boolean {
  return invited || ownsByConfig(env, userId, login);
}

/** canSignIn once the facts are known. */
function maySignIn(env: Env, userId: string, login: string, s: Standing): boolean {
  return mayOwn(env, userId, login, s.invited) || s.liveShare;
}

/**
 * Who may sign in: everyone who may own robots, and guests. A guest is someone a robot is shared
 * with (by GitHub id) whose owner may still own robots; they can open the robots shared with them
 * and nothing more: no robots of their own (their robot limit is 0), and they are not on the
 * admin page. Checked on every request, so a guest's last share ending signs them out at once.
 * `login` is the caller's: OAuth passes the one GitHub just returned, not the stored one.
 */
export async function canSignIn(env: Env, userId: string, login: string): Promise<boolean> {
  if (ownsByConfig(env, userId, login)) return true;
  return maySignIn(env, userId, login, (await standings(env, [userId])).get(userId)!);
}

/** D1 binds at most 100 parameters per statement; one is kept for a timestamp. */
const MAX_PARAMS = 99;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_PARAMS) out.push(items.slice(i, i + MAX_PARAMS));
  return out;
}

const placeholders = (n: number) => Array.from({ length: n }, (_, i) => `?${i + 1}`).join(", ");

interface Standing {
  login: string | null; // null: no users row
  invited: boolean;
  liveShare: boolean;
}

/**
 * The sign-in rule's facts for many people, one query per 100: their stored login, whether they
 * are invited, and whether a robot is shared with them by an owner who may still own robots
 * (canOwn for every distinct owner, with their invitation looked up in the same query).
 */
async function standings(env: Env, userIds: string[]): Promise<Map<string, Standing>> {
  const out = new Map<string, Standing>();
  for (const ids of chunks([...new Set(userIds)])) {
    const rows = await env.DB.prepare(
      `WITH ids(id) AS (VALUES ${ids.map((_, i) => `(?${i + 1})`).join(", ")})
       SELECT ids.id AS user_id, (SELECT login FROM users WHERE id = ids.id) AS login,
              EXISTS (SELECT 1 FROM invites i WHERE i.user_id = ids.id) AS invited,
              NULL AS owner_id, NULL AS owner_login, 0 AS owner_invited
       FROM ids
       UNION ALL
       SELECT DISTINCT m.user_id, NULL, 0, o.user_id, u.login, EXISTS (SELECT 1 FROM invites i WHERE i.user_id = o.user_id)
       FROM members m
         JOIN robots r ON r.robot_id = m.robot_id AND r.status = 'claimed'
         JOIN members o ON o.robot_id = m.robot_id AND o.role = 'owner'
         JOIN users u ON u.id = o.user_id
       WHERE m.user_id IN (SELECT id FROM ids) AND m.role != 'owner'`,
    )
      .bind(...ids)
      .all<{ user_id: string; login: string | null; invited: number; owner_id: string | null; owner_login: string; owner_invited: number }>();
    for (const r of rows.results) if (r.owner_id === null) out.set(r.user_id, { login: r.login, invited: r.invited === 1, liveShare: false });
    for (const r of rows.results) {
      if (r.owner_id !== null && mayOwn(env, r.owner_id, r.owner_login, r.owner_invited === 1)) out.get(r.user_id)!.liveShare = true;
    }
  }
  return out;
}

/**
 * After someone lost a share: if they have no other way to sign in (a guest's last share), end
 * their relay sessions, app devices and pending app sign-ins at once. Sign-in is also checked on
 * every request, so this is cleanup, not the gate. Someone who never signed in leaves no row.
 */
export async function afterShareEnded(env: Env, userId: string): Promise<boolean> {
  return (await afterSharesEnded(env, [userId])).has(userId);
}

/**
 * afterShareEnded for many people (the guests of an unlinked robot), in a number of D1 calls that
 * does not grow with them below 100: one query for who can still sign in, one batch for the rest.
 * Returns who was signed out. Someone without a users row cannot sign in and has nothing to end.
 */
export async function afterSharesEnded(env: Env, userIds: string[]): Promise<Set<string>> {
  const gone = new Set<string>();
  for (const [id, s] of await standings(env, userIds)) if (s.login === null || !maySignIn(env, id, s.login, s)) gone.add(id);
  const now = nowSeconds();
  const steps = chunks([...gone]).flatMap((ids) => {
    const in_ = placeholders(ids.length);
    return [
      // Their AI agents (docs/agent-delegation.md) go with their last way in; a person who is
      // signed out has nothing to delegate.
      env.DB.prepare(
        `INSERT INTO delegation_events (delegation_id, at, actor, action, outcome, detail)
         SELECT delegation_id, ?${ids.length + 1}, 'admin', 'revoke', 'ok', 'the person lost access to every robot' FROM delegations
         WHERE user_id IN (${in_}) AND revoked_at IS NULL`,
      ).bind(...ids, now),
      env.DB.prepare(`UPDATE delegations SET revoked_at = ?${ids.length + 1} WHERE user_id IN (${in_}) AND revoked_at IS NULL`).bind(...ids, now),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id IN (${in_})`).bind(...ids),
      env.DB.prepare(`DELETE FROM devices WHERE user_id IN (${in_})`).bind(...ids),
      env.DB.prepare(`DELETE FROM app_codes WHERE user_id IN (${in_})`).bind(...ids),
      env.DB.prepare(
        `DELETE FROM users WHERE id IN (${in_}) AND last_login_at = 0 AND NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id = users.id)`,
      ).bind(...ids),
    ];
  });
  if (steps.length > 0) await env.DB.batch(steps);
  return gone;
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
