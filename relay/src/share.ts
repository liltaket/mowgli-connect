import { afterShareEnded, GITHUB_USER_ID } from "./access";
import { cleanGithubLogin, lookupError } from "./admin";
import type { Env } from "./env";
import type { GithubProfile } from "./github";
import { lookupGithubUser } from "./github";
import { html, page, type PageUser } from "./html";
import { clearSessionCookie, type SessionUser } from "./session";
import { isRobotId, nowSeconds, readBodyText } from "./util";

/**
 * Sharing a robot (docs/protocol.md, "Sharing"): its owner lets another GitHub account open it,
 * "View only" (role viewer) or "Can control" (role operator), by the account's numeric id, never
 * by login. There are no share links: a link that grants access would be a bearer token. Every
 * write here passes the browser handler's Origin check (CSRF); every owner action re-checks
 * ownership in the statement that changes anything, and answers like an unknown robot otherwise.
 */

export const MAX_SHARES_PER_ROBOT = 10;
export const SHARES_PER_OWNER_PER_HOUR = 10;
export const LOOKUPS_PER_PERSON_PER_HOUR = 20;
/** For the whole relay: GitHub's rate limit for the OAuth app is shared with sign-ins. */
export const LOOKUPS_PER_HOUR = 300;

export type SharedRole = "viewer" | "operator";

const SHARE_PATH = /^\/robots\/([^/]+)\/(share|leave|members\/([^/]+)\/(role|remove))$/;

export function isSharePath(pathname: string): boolean {
  return SHARE_PATH.test(pathname);
}

export function roleLabel(role: string): string {
  return role === "owner" ? "Owner" : role === "operator" ? "Can control" : "View only";
}

const ROLE_HELP: Record<SharedRole, string> = {
  viewer: "They see the robot's status, its live map and its schedules.",
  operator: "They also start, pause and stop mowing, send the robot to its dock and press the emergency stop.",
};

const NOT_ALLOWED =
  "Neither can change the robot's settings, maps or schedules, drive it with the joystick, release an emergency stop, restart or update anything, or share it further. Only you can.";

const NOTICES: Record<string, string> = {
  shared: "Shared. They can sign in with their GitHub account and open the robot now.",
  already: "That account already has access to this robot.",
  role: "Saved. The robot applies it within a few minutes.",
  removed: "Removed. They can no longer open this robot; a session they have open on it ends within a few minutes.",
};

function parseRole(v: string | null): SharedRole | null {
  return v === "viewer" || v === "operator" ? v : null;
}

function redirect(location: string, extra: HeadersInit = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...extra } });
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/x-www-form-urlencoded")) return null;
  const text = await readBodyText(request, 2048);
  return text === null ? null : new URLSearchParams(text);
}

function initial(s: string): string {
  return s.trim().charAt(0).toUpperCase() || "?";
}

function day(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

interface OwnedRobot {
  robot_id: string;
  name: string;
}

/** The robot, if this person owns it and it is claimed. */
async function ownedRobot(env: Env, robotId: string, userId: string): Promise<OwnedRobot | null> {
  const r = await env.DB.prepare(
    `SELECT r.robot_id, COALESCE(m.label, r.name, r.robot_id) AS name FROM members m JOIN robots r ON r.robot_id = m.robot_id
     WHERE m.robot_id = ? AND m.user_id = ? AND m.role = 'owner' AND r.status = 'claimed'`,
  )
    .bind(robotId, userId)
    .first<OwnedRobot>();
  return r ?? null;
}

// The owner check, for statements that change members: `?1` robot, `?OWNER` the signed-in owner.
const IS_OWNER = (owner: string) =>
  `EXISTS (SELECT 1 FROM members o JOIN robots r ON r.robot_id = o.robot_id
           WHERE o.robot_id = ?1 AND o.user_id = ${owner} AND o.role = 'owner' AND r.status = 'claimed')`;

/**
 * Reserves one GitHub lookup from this person's hourly budget and the relay's, in one statement
 * so concurrent requests cannot all pass one count. Failed lookups count too: the form must not
 * work as a way to test which accounts exist.
 */
async function reserveLookup(env: Env, userId: string): Promise<boolean> {
  const now = nowSeconds();
  const r = await env.DB.prepare(
    `INSERT INTO share_events (user_id, kind, at) SELECT ?1, 'lookup', ?2
     WHERE (SELECT COUNT(*) FROM share_events WHERE user_id = ?1 AND kind = 'lookup' AND at > ?3) < ?4
       AND (SELECT COUNT(*) FROM share_events WHERE kind = 'lookup' AND at > ?3) < ?5`,
  )
    .bind(userId, now, now - 3600, LOOKUPS_PER_PERSON_PER_HOUR, LOOKUPS_PER_HOUR)
    .run();
  return r.meta.changes === 1;
}

async function lookup(env: Env, userId: string, by: { login: string } | { id: number }): Promise<{ ok: true; user: GithubProfile } | { ok: false; message: string; status: number }> {
  if (!(await reserveLookup(env, userId))) {
    return { ok: false, status: 429, message: "You looked up many GitHub accounts in the last hour. Try again later." };
  }
  const res = await lookupGithubUser(env, by);
  if (!res.ok) return { ok: false, status: res.reason === "unavailable" ? 502 : 400, message: lookupError(res.reason, "login" in by ? by.login : undefined) };
  return res;
}

interface ShareRow {
  user_id: string;
  role: SharedRole;
  created_at: number;
  login: string;
  name: string | null;
  last_login_at: number;
}

function roleSelect(id: string, selected: SharedRole) {
  return html`<select id="${id}" name="role">${(["viewer", "operator"] as const).map(
    (r) => html`<option value="${r}"${r === selected ? html` selected` : ""}>${roleLabel(r)}</option>`,
  )}</select>`;
}

async function sharePage(env: Env, user: SessionUser, robot: OwnedRobot, pu: PageUser, url: URL, error?: string, status = 200): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT m.user_id, m.role, m.created_at, u.login, u.name, u.last_login_at FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.robot_id = ? AND m.role != 'owner' ORDER BY m.created_at, m.user_id`,
  )
    .bind(robot.robot_id)
    .all<ShareRow>();
  const key = url.searchParams.get("notice") ?? "";
  const notice = Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
  const base = `/robots/${robot.robot_id}`;
  const full = rows.results.length >= MAX_SHARES_PER_ROBOT;
  return page(
    "Sharing",
    html`
${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<h1>Share ${robot.name}</h1>
<p class="muted">People you share with open the robot from their own Mowgli Connect account, signed in with their own GitHub account. Nobody needs your login.</p>

<h2>People with access <span class="count">${rows.results.length + 1}</span></h2>
<ul class="people">
<li class="person"><span class="avatar" aria-hidden="true">${initial(user.name ?? user.login)}</span>
<div class="person-main"><span class="person-name">@${user.login}${user.name ? html` <span class="muted">${user.name}</span>` : ""}</span>
<span class="meta"><span>You, owner</span></span></div></li>
${rows.results.map(
  (p) => html`<li class="person"><span class="avatar" aria-hidden="true">${initial(p.name ?? p.login)}</span>
<div class="person-main"><span class="person-name">@${p.login}${p.name ? html` <span class="muted">${p.name}</span>` : ""}</span>
<span class="meta"><span>${roleLabel(p.role)}</span><span>Since ${day(p.created_at)}</span>${p.last_login_at === 0 ? html`<span>Not signed in yet</span>` : ""}</span></div>
<details><summary>Change</summary><div class="manage">
<form method="post" action="${base}/members/${p.user_id}/role"><label for="role-${p.user_id}">What they can do</label>
<div class="inline-fields">${roleSelect(`role-${p.user_id}`, p.role)}<button>Save</button></div>
<p>The robot applies a change within a few minutes.</p></form>
<form method="post" action="${base}/members/${p.user_id}/remove"><button class="danger">Remove</button>
<p>They can no longer open this robot. A session they have open on it ends within a few minutes.</p></form>
</div></details></li>`,
)}
</ul>

<h2>Share with someone</h2>
${
  full
    ? html`<div class="empty"><strong>This robot is shared with ${MAX_SHARES_PER_ROBOT} people, the most it can be.</strong><span>Remove someone to share it with another person.</span></div>`
    : html`<form class="panel" method="post" action="${base}/share">
<div class="fields"><div><label for="login">GitHub username</label><input type="text" id="login" name="login" placeholder="octocat" required maxlength="80" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-describedby="share-hint"></div>
<div><label for="role">They can</label>${roleSelect("role", "viewer")}</div>
<button class="primary">Find account</button></div>
<div class="muted hint" id="share-hint"><p>You see the account before anything is shared. Access follows the account itself, so it keeps working if they rename it.</p>
<p><strong>View only:</strong> ${ROLE_HELP.viewer} <strong>Can control:</strong> ${ROLE_HELP.operator}</p><p>${NOT_ALLOWED}</p></div>
</form>`
}
<p><a href="/">Back to my robots</a></p>`,
    status,
    {},
    pu,
  );
}

function confirmShare(robot: OwnedRobot, gh: GithubProfile, role: SharedRole, pu: PageUser): Response {
  const since = gh.createdAt ? gh.createdAt.slice(0, 4) : null;
  return page(
    "Share",
    html`<h1>Share ${robot.name} with @${gh.login}?</h1>
<div class="panel invitee"><span class="avatar big" aria-hidden="true">${initial(gh.name ?? gh.login)}</span>
<div><strong>${gh.name ?? `@${gh.login}`}</strong><span class="muted">@${gh.login}${since ? `, on GitHub since ${since}` : ""}</span>
<a href="https://github.com/${gh.login}" rel="noreferrer">Check the profile on GitHub</a></div></div>
<p><strong>${roleLabel(role)}:</strong> ${ROLE_HELP.viewer}${role === "operator" ? html` ${ROLE_HELP.operator}` : ""}</p>
<p class="muted">${NOT_ALLOWED} Make sure this is the right account: it is the one that gets access, even if someone else later takes the name.</p>
<form method="post" action="/robots/${robot.robot_id}/share"><input type="hidden" name="id" value="${String(gh.id)}"><input type="hidden" name="role" value="${role}">
<p class="actions"><button class="primary">Share with @${gh.login}</button> <a class="btn" href="/robots/${robot.robot_id}/share">Cancel</a></p></form>`,
    200,
    {},
    pu,
  );
}

type Outcome = { ok: true } | { ok: false; notice?: string; error?: string; status: number };

/** Adds the share in one transaction, re-checking ownership and every limit as it writes. */
async function addShare(env: Env, owner: SessionUser, robotId: string, gh: GithubProfile, role: SharedRole): Promise<Outcome> {
  const target = `gh:${gh.id}`;
  if (target === owner.id) return { ok: false, status: 400, error: "That is your own account. You own this robot already." };
  const now = nowSeconds();
  const [, ins] = await env.DB.batch([
    // A person who never signed in needs a users row (members refers to it); last_login_at 0
    // marks it. Their GitHub login and name are kept for this page only.
    env.DB.prepare("INSERT INTO users (id, login, name, created_at, last_login_at) VALUES (?, ?, ?, ?, 0) ON CONFLICT(id) DO NOTHING").bind(
      target,
      gh.login,
      gh.name,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO members (robot_id, user_id, role, label, created_at)
       SELECT ?1, ?2, ?3, NULL, ?4
       WHERE ${IS_OWNER("?5")}
         AND (SELECT COUNT(*) FROM members WHERE robot_id = ?1 AND role != 'owner') < ?6
         AND (SELECT COUNT(*) FROM share_events WHERE user_id = ?5 AND kind = 'share' AND at > ?7) < ?8
       ON CONFLICT(robot_id, user_id) DO NOTHING`,
    ).bind(robotId, target, role, now, owner.id, MAX_SHARES_PER_ROBOT, now - 3600, SHARES_PER_OWNER_PER_HOUR),
    env.DB.prepare("INSERT INTO share_events (user_id, kind, at) SELECT ?, 'share', ? WHERE changes() > 0").bind(owner.id, now),
    env.DB.prepare("DELETE FROM users WHERE id = ?1 AND last_login_at = 0 AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = ?1)").bind(target),
  ]);
  if (ins?.meta.changes === 1) return { ok: true };
  // Nothing was written; say why.
  if (!(await ownedRobot(env, robotId, owner.id))) return { ok: false, status: 404 };
  const member = await env.DB.prepare("SELECT 1 AS ok FROM members WHERE robot_id = ? AND user_id = ?").bind(robotId, target).first();
  if (member) return { ok: false, status: 409, notice: "already" };
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE robot_id = ? AND role != 'owner'").bind(robotId).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_SHARES_PER_ROBOT) return { ok: false, status: 403, error: `This robot is shared with ${MAX_SHARES_PER_ROBOT} people, the most it can be. Remove someone first.` };
  return { ok: false, status: 429, error: `You shared robots with ${SHARES_PER_OWNER_PER_HOUR} people in the last hour, the most allowed. Try again later.` };
}

/** /robots/:id/share (GET, POST), /robots/:id/members/:userId/(role|remove) (POST), /robots/:id/leave (POST). */
export async function handleShare(
  request: Request,
  env: Env,
  url: URL,
  user: SessionUser | null,
  pageUser: (u: SessionUser) => PageUser,
  loginRedirect: (u: URL) => Response,
  notFound: () => Response,
): Promise<Response> {
  const m = SHARE_PATH.exec(url.pathname)!;
  const robotId = m[1]!;
  const action = m[4] ?? m[2]!;
  const method = request.method;
  const allow = action === "share" ? ["GET", "POST"] : ["POST"];
  if (!allow.includes(method)) return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow.join(", ") } });
  if (!user) return method === "GET" ? loginRedirect(url) : redirect("/login");
  if (!isRobotId(robotId)) return notFound();

  if (action === "leave") {
    // Anyone the robot is shared with may leave it; the owner unlinks instead.
    const del = await env.DB.prepare("DELETE FROM members WHERE robot_id = ? AND user_id = ? AND role != 'owner'").bind(robotId, user.id).run();
    if (del.meta.changes !== 1) return notFound();
    console.log("share: left", robotId);
    return (await afterShareEnded(env, user.id)) ? redirect("/?notice=left_last", { "Set-Cookie": clearSessionCookie() }) : redirect("/?notice=left");
  }

  // Everything else is the owner's. Anyone else, the people it is shared with included, gets the
  // same answer as for a robot that does not exist.
  const robot = await ownedRobot(env, robotId, user.id);
  if (!robot) return notFound();
  const pu = pageUser(user);
  const base = `/robots/${robotId}/share`;

  if (action === "share" && method === "GET") return sharePage(env, user, robot, pu, url);

  const form = await readForm(request);
  if (!form) return sharePage(env, user, robot, pu, url, "The form was not filled in correctly.", 400);

  if (action === "share") {
    const role = parseRole(form.get("role"));
    if (!role) return sharePage(env, user, robot, pu, url, "Choose View only or Can control.", 400);
    const id = form.get("id");
    if (id !== null) {
      // Step 2: the owner confirmed the account shown in step 1. Look it up again by id, so the
      // stored login and name are GitHub's and the id is a person's account, not the form's say.
      if (!/^[1-9][0-9]{0,19}$/.test(id) || !Number.isSafeInteger(Number(id))) return sharePage(env, user, robot, pu, url, "That account id is not valid.", 400);
      const res = await lookup(env, user.id, { id: Number(id) });
      if (!res.ok) return sharePage(env, user, robot, pu, url, res.message, res.status);
      const out = await addShare(env, user, robotId, res.user, role);
      if (out.ok) {
        console.log("share: added", robotId, role);
        return redirect(`${base}?notice=shared`);
      }
      if (out.status === 404) return notFound();
      if (out.notice) return redirect(`${base}?notice=${out.notice}`);
      return sharePage(env, user, robot, pu, url, out.error, out.status);
    }
    // Step 1: find the account by login and show it.
    const login = cleanGithubLogin(form.get("login"));
    if (!login) return sharePage(env, user, robot, pu, url, "That is not a GitHub username. It has letters, digits and dashes, like octocat.", 400);
    const res = await lookup(env, user.id, { login });
    if (!res.ok) return sharePage(env, user, robot, pu, url, res.message, res.status);
    const target = `gh:${res.user.id}`;
    if (target === user.id) return sharePage(env, user, robot, pu, url, "That is your own account. You own this robot already.", 400);
    const member = await env.DB.prepare("SELECT 1 AS ok FROM members WHERE robot_id = ? AND user_id = ?").bind(robotId, target).first();
    if (member) return sharePage(env, user, robot, pu, url, `@${res.user.login} already has access to this robot. Change what they can do in the list below.`, 409);
    return confirmShare(robot, res.user, role, pu);
  }

  const target = m[3]!;
  if (!GITHUB_USER_ID.test(target)) return notFound();
  if (action === "role") {
    const role = parseRole(form.get("role"));
    if (!role) return sharePage(env, user, robot, pu, url, "Choose View only or Can control.", 400);
    // Never the owner's row, and only on a robot this person owns, checked in the same statement.
    const upd = await env.DB.prepare(`UPDATE members SET role = ?3 WHERE robot_id = ?1 AND user_id = ?2 AND role != 'owner' AND ${IS_OWNER("?4")}`)
      .bind(robotId, target, role, user.id)
      .run();
    if (upd.meta.changes !== 1) return notFound();
    console.log("share: role", robotId, role);
    return redirect(`${base}?notice=role`);
  }
  // remove
  const del = await env.DB.prepare(`DELETE FROM members WHERE robot_id = ?1 AND user_id = ?2 AND role != 'owner' AND ${IS_OWNER("?3")}`)
    .bind(robotId, target, user.id)
    .run();
  if (del.meta.changes !== 1) return notFound();
  await afterShareEnded(env, target);
  console.log("share: removed", robotId);
  return redirect(`${base}?notice=removed`);
}
