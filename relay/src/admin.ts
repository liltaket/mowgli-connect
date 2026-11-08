import { defaultRobotLimit, GITHUB_USER_ID, isAdmin, isUserAllowed, MAX_ROBOT_LIMIT, parseRobotLimit } from "./access";
import type { Env } from "./env";
import { unlinkRobot } from "./claim";
import { GITHUB_LOGIN, lookupGithubUser } from "./github";
import { html, page } from "./html";
import type { SessionUser } from "./session";
import { createProvisioner } from "./provisioner";
import { isRobotId, nowSeconds, readBodyText } from "./util";

/**
 * The admin page: who may sign in, and how many robots each person may own. Only accounts in
 * ADMIN_GITHUB_IDS (by GitHub id) can reach it; everyone else gets the ordinary 404. Every write
 * also passes the browser handler's Origin check (CSRF).
 */

const NOTICES: Record<string, string> = {
  invited: "Invitation added. They can sign in now.",
  already: "That account was already invited.",
  removed: "Access removed. Their sessions here have ended, and their robots stop accepting them within a few minutes.",
  unlinked: "Robot unlinked. Its tunnel is being deleted.",
  removed_unlinked: "Access removed and their robots unlinked. Their sessions here have ended.",
  removed_config:
    "Invitation removed, but they can still sign in: the relay's configuration (ALLOWED_GITHUB_LOGINS) also lets them in. Remove them there to end their access.",
  limit: "Robot limit saved.",
  settings: "Default robot limit saved.",
};

const ADMIN_PATH = /^\/admin(?:\/invite|\/settings|\/people\/(gh:[1-9][0-9]{0,19})\/(limit|remove)|\/robots\/([a-z2-7]{16})\/unlink)?$/;

export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATH.test(pathname);
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.startsWith("application/x-www-form-urlencoded")) return null;
  const text = await readBodyText(request, 2048);
  return text === null ? null : new URLSearchParams(text);
}

/** "octocat", "@octocat" or "https://github.com/octocat" -> "octocat", or null. */
export function cleanGithubLogin(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");
  return GITHUB_LOGIN.test(s) ? s : null;
}

function ago(t: number | null): string {
  if (!t) return "Not signed in yet";
  const d = Math.max(0, nowSeconds() - t);
  if (d < 3600) return "Signed in within the last hour";
  if (d < 86400) return `Signed in ${Math.floor(d / 3600)} h ago`;
  const days = Math.floor(d / 86400);
  return `Signed in ${days} ${days === 1 ? "day" : "days"} ago`;
}

function day(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

interface PersonRow {
  user_id: string;
  invite_login: string;
  invite_name: string | null;
  robot_limit: number | null;
  created_at: number;
  login: string | null;
  name: string | null;
  last_login_at: number | null;
  robots: number;
}

async function adminPage(env: Env, user: SessionUser, url: URL, error?: string, status = 200): Promise<Response> {
  const def = await defaultRobotLimit(env);
  const people = await env.DB.prepare(
    `SELECT i.user_id, i.login AS invite_login, i.name AS invite_name, i.robot_limit, i.created_at,
            u.login, u.name, u.last_login_at,
            (SELECT COUNT(*) FROM members m JOIN robots r ON r.robot_id = m.robot_id
             WHERE m.user_id = i.user_id AND m.role = 'owner' AND r.status = 'claimed') AS robots
     FROM invites i LEFT JOIN users u ON u.id = i.user_id
     ORDER BY lower(COALESCE(u.login, i.login))`,
  ).all<PersonRow>();
  const mine = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM members m JOIN robots r ON r.robot_id = m.robot_id
     WHERE m.user_id = ? AND m.role = 'owner' AND r.status = 'claimed'`,
  )
    .bind(user.id)
    .first<{ n: number }>();
  const orphans = await orphanedRobots(env);
  const key = url.searchParams.get("notice") ?? "";
  const notice = Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
  return page(
    "Admin",
    html`
${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
${error ? html`<p class="error" role="alert">${error}</p>` : ""}
<h1>Admin</h1>
<p class="muted">Who can sign in to Mowgli Connect, and how many robots each person can add.</p>

<h2>Invite someone</h2>
<form class="panel" method="post" action="/admin/invite">
<div class="fields fields-2"><div><label for="login">GitHub username</label><input type="text" id="login" name="login" placeholder="octocat" required maxlength="80" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" aria-describedby="login-hint"></div>
<button class="primary">Find account</button></div>
<p class="muted hint" id="login-hint">You see the account before it is invited. Access follows the account itself, so it keeps working if they rename it.</p>
</form>

<h2>People <span class="count">${people.results.length + 1}</span></h2>
<ul class="people">
<li class="person"><span class="avatar" aria-hidden="true">${initial(user.name ?? user.login)}</span>
<div class="person-main"><span class="person-name">@${user.login}${user.name ? html` <span class="muted">${user.name}</span>` : ""}</span>
<span class="meta"><span>You, admin</span><span>${mine?.n ?? 0} ${(mine?.n ?? 0) === 1 ? "robot" : "robots"}, no limit</span></span></div></li>
${people.results.map((p) => {
  const login = p.login ?? p.invite_login;
  const name = p.name ?? p.invite_name;
  const limit = p.robot_limit ?? def;
  return html`<li class="person"><span class="avatar" aria-hidden="true">${initial(name ?? login)}</span>
<div class="person-main"><span class="person-name">@${login}${name ? html` <span class="muted">${name}</span>` : ""}</span>
<span class="meta"><span>${ago(p.last_login_at)}</span><span>Invited ${day(p.created_at)}</span><span class="${p.robots >= limit ? "full" : ""}">${p.robots} of ${limit} ${limit === 1 ? "robot" : "robots"}${p.robot_limit === null ? " (default)" : ""}</span></span></div>
<details><summary>Change</summary><div class="manage">
<form method="post" action="/admin/people/${p.user_id}/limit"><label for="limit-${p.user_id}">Robot limit</label>
<div class="inline-fields"><input type="number" inputmode="numeric" id="limit-${p.user_id}" name="limit" min="0" max="${MAX_ROBOT_LIMIT}" value="${p.robot_limit ?? ""}" placeholder="${def} (default)"><button>Save</button></div>
<p>Leave empty to use the default (${def}). A lower limit keeps the robots they already have.</p></form>
<form method="post" action="/admin/people/${p.user_id}/remove">${
    p.robots > 0
      ? html`<label class="check"><input type="checkbox" name="unlink" value="1"> Also unlink their ${p.robots === 1 ? "robot" : `${p.robots} robots`}</label>`
      : ""
  }<button class="danger">Remove access</button>
<p>They can no longer sign in or open their robots. ${p.robots > 0 ? "Unless you unlink them, their robots stay paired, so they can come back if you invite them again." : ""}</p></form>
</div></details></li>`;
})}
</ul>

${
  orphans.length
    ? html`<h2>Robots nobody can use <span class="count">${orphans.length}</span></h2>
<p class="muted">Their owners no longer have access. Unlinking deletes the robot's tunnel; it needs a new pairing code to be added again.</p>
<ul class="people">${orphans.map(
        (o) => html`<li class="person"><span class="avatar" aria-hidden="true">${initial(o.label ?? o.name ?? "?")}</span>
<div class="person-main"><span class="person-name">${o.label ?? o.name ?? o.robot_id}</span>
<span class="meta"><span>${o.hostname ?? o.robot_id}</span><span>Owner @${o.login ?? o.user_id}</span></span></div>
<form class="orphan-unlink" method="post" action="/admin/robots/${o.robot_id}/unlink"><button class="danger">Unlink</button></form></li>`,
      )}</ul>`
    : ""
}

<h2>Default robot limit</h2>
<form class="panel" method="post" action="/admin/settings">
<label for="default-limit">Robots per person</label>
<div class="inline-fields"><input type="number" inputmode="numeric" id="default-limit" name="default_limit" min="0" max="${MAX_ROBOT_LIMIT}" value="${def}" required aria-describedby="default-hint"><button class="primary">Save</button></div>
<p class="muted hint" id="default-hint">For everyone without a limit of their own. Lowering it does not remove robots anyone already has.</p>
</form>`,
    status,
    {},
    { login: user.login, name: user.name, admin: true },
  );
}

function initial(s: string): string {
  return s.trim().charAt(0).toUpperCase() || "?";
}

function confirmInvite(user: SessionUser, gh: { id: number; login: string; name: string | null; createdAt: string | null }, already: boolean): Response {
  const since = gh.createdAt ? gh.createdAt.slice(0, 4) : null;
  return page(
    "Invite",
    html`<h1>Invite @${gh.login}?</h1>
<div class="panel invitee"><span class="avatar big" aria-hidden="true">${initial(gh.name ?? gh.login)}</span>
<div><strong>${gh.name ?? `@${gh.login}`}</strong><span class="muted">@${gh.login}${since ? `, on GitHub since ${since}` : ""}</span>
<a href="https://github.com/${gh.login}" rel="noreferrer">Check the profile on GitHub</a></div></div>
${already ? html`<p class="notice">This account is already invited.</p>` : html`<p class="muted">They can sign in with this GitHub account and add up to the default number of robots. You can change that afterwards.</p>`}
<form method="post" action="/admin/invite"><input type="hidden" name="id" value="${String(gh.id)}">
<p class="actions">${already ? "" : html`<button class="primary">Invite @${gh.login}</button> `}<a class="btn" href="/admin">${already ? "Back" : "Cancel"}</a></p></form>`,
    200,
    {},
    { login: user.login, name: user.name, admin: true },
  );
}

export async function handleAdmin(request: Request, env: Env, url: URL, user: SessionUser | null, notFound: () => Response): Promise<Response> {
  if (!user || !isAdmin(env, user.id)) return notFound();
  const m = ADMIN_PATH.exec(url.pathname)!;
  const method = request.method;

  if (url.pathname === "/admin") {
    return method === "GET" ? adminPage(env, user, url) : methodNotAllowed("GET");
  }
  if (method !== "POST") return methodNotAllowed("POST");
  const form = await readForm(request);
  if (!form) return adminPage(env, user, url, "The form was not filled in correctly.", 400);

  if (url.pathname === "/admin/invite") {
    const id = form.get("id");
    if (id !== null) {
      // Step 2: the admin confirmed the account shown in step 1. Look it up again by id, so the
      // stored login and name are GitHub's, not the form's.
      if (!/^[1-9][0-9]{0,19}$/.test(id) || !Number.isSafeInteger(Number(id))) return adminPage(env, user, url, "That account id is not valid.", 400);
      const res = await lookupGithubUser(env, { id: Number(id) });
      if (!res.ok) return adminPage(env, user, url, lookupError(res.reason), res.reason === "unavailable" ? 502 : 400);
      const userId = `gh:${res.user.id}`;
      if (isAdmin(env, userId)) return redirect("/admin?notice=already");
      const ins = await env.DB.prepare(
        "INSERT INTO invites (user_id, login, name, robot_limit, invited_by, created_at) VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT(user_id) DO NOTHING",
      )
        .bind(userId, res.user.login, res.user.name, user.id, nowSeconds())
        .run();
      console.log("admin: invited", userId, "by", user.id);
      return redirect(ins.meta.changes === 1 ? "/admin?notice=invited" : "/admin?notice=already");
    }
    // Step 1: find the account and show it.
    const login = cleanGithubLogin(form.get("login"));
    if (!login) return adminPage(env, user, url, "That is not a GitHub username. It has letters, digits and dashes, like octocat.", 400);
    const res = await lookupGithubUser(env, { login });
    if (!res.ok) return adminPage(env, user, url, lookupError(res.reason, login), res.reason === "unavailable" ? 502 : 400);
    const userId = `gh:${res.user.id}`;
    const already = isAdmin(env, userId) || (await env.DB.prepare("SELECT 1 AS ok FROM invites WHERE user_id = ?").bind(userId).first()) !== null;
    return confirmInvite(user, res.user, already);
  }

  if (url.pathname === "/admin/settings") {
    const n = parseRobotLimit(form.get("default_limit"));
    if (n === null) return adminPage(env, user, url, `The default limit must be a whole number from 0 to ${MAX_ROBOT_LIMIT}.`, 400);
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('default_robot_limit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(String(n))
      .run();
    console.log("admin: default robot limit", n, "by", user.id);
    return redirect("/admin?notice=settings");
  }

  if (m[3]) {
    // Only robots whose owner has lost access: the admin page is not a way into anyone's robot.
    const robotId = m[3];
    if (!isRobotId(robotId) || !(await orphanedRobots(env)).some((o) => o.robot_id === robotId)) return notFound();
    if (!(await unlinkRobot(env, createProvisioner(env), robotId))) return notFound();
    console.log("admin: unlinked orphaned robot", robotId, "by", user.id);
    return redirect("/admin?notice=unlinked");
  }

  const target = m[1]!;
  if (!GITHUB_USER_ID.test(target)) return notFound();
  if (m[2] === "limit") {
    const raw = (form.get("limit") ?? "").trim();
    const n = raw === "" ? null : parseRobotLimit(raw);
    if (raw !== "" && n === null) return adminPage(env, user, url, `A robot limit must be a whole number from 0 to ${MAX_ROBOT_LIMIT}, or empty for the default.`, 400);
    const res = await env.DB.prepare("UPDATE invites SET robot_limit = ? WHERE user_id = ?").bind(n, target).run();
    if (res.meta.changes !== 1) return notFound();
    console.log("admin: robot limit", target, n, "by", user.id);
    return redirect("/admin?notice=limit");
  }
  // remove
  const del = await env.DB.prepare("DELETE FROM invites WHERE user_id = ?").bind(target).run();
  if (del.meta.changes !== 1) return notFound(); // only invited people, never an admin
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target).run();
  console.log("admin: removed", target, "by", user.id);
  // Say so when the configuration still lets them in, instead of promising what did not happen.
  const login = await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(target).first<{ login: string }>();
  const still = await isUserAllowed(env, target, login?.login ?? "");
  if (still) return redirect("/admin?notice=removed_config");
  if (form.get("unlink") === "1") {
    const owned = await env.DB.prepare(
      `SELECT m.robot_id FROM members m JOIN robots r ON r.robot_id = m.robot_id
       WHERE m.user_id = ? AND m.role = 'owner' AND r.status = 'claimed'`,
    )
      .bind(target)
      .all<{ robot_id: string }>();
    const prov = createProvisioner(env);
    for (const r of owned.results) await unlinkRobot(env, prov, r.robot_id);
    console.log("admin: unlinked", owned.results.length, "robots of", target, "by", user.id);
    return redirect("/admin?notice=removed_unlinked");
  }
  return redirect("/admin?notice=removed");
}

function lookupError(reason: "not_found" | "not_a_user" | "unavailable", login?: string): string {
  if (reason === "not_found") return login ? `There is no GitHub account called ${login}.` : "That GitHub account no longer exists.";
  if (reason === "not_a_user") return "That is an organization or a bot, not a person's account.";
  return "GitHub did not answer. Try again in a moment.";
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow } });
}

interface OrphanRow {
  robot_id: string;
  name: string | null;
  hostname: string | null;
  label: string | null;
  user_id: string;
  login: string | null;
}

/** Claimed robots whose owner can no longer sign in (removed from the invites, say). */
async function orphanedRobots(env: Env): Promise<OrphanRow[]> {
  const rows = await env.DB.prepare(
    `SELECT r.robot_id, r.name, r.hostname, m.label, m.user_id, u.login
     FROM members m JOIN robots r ON r.robot_id = m.robot_id LEFT JOIN users u ON u.id = m.user_id
     WHERE m.role = 'owner' AND r.status = 'claimed' AND m.user_id NOT IN (SELECT user_id FROM invites)
     ORDER BY r.robot_id`,
  ).all<OrphanRow>();
  const out: OrphanRow[] = [];
  for (const r of rows.results) {
    if (!(await isUserAllowed(env, r.user_id, r.login ?? ""))) out.push(r);
  }
  return out;
}
