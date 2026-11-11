import { isUserAllowed } from "./access";
import { claimRobot, limitMessage, planAddress, previewClaim, reachedLimit, unlinkRobot } from "./claim";
import { b64urlDecode, importEd25519Public, parseJws, verifyJws } from "./crypto";
import { DELEGATE_ID, DelegateAuthError, deriveDelegateId, fingerprint, verifyDelegateAssertion } from "./delegateAuth";
import type { Env } from "./env";
import { GRANT_TTL_SECONDS, mintGrant } from "./grant";
import { html, page, type PageUser, type SafeHtml } from "./html";
import { createProvisioner } from "./provisioner";
import { json } from "./robotApi";
import type { SessionUser } from "./session";
import { latestAgentSha, updateAvailable } from "./updates";
import { cleanLabel, isRobotId, nowSeconds, readBodyBytes, readBodyText, SKEW_SECONDS } from "./util";

/**
 * Delegations to AI agents and automations (docs/agent-delegation.md): approved by the person on
 * a consent page, bound to an Ed25519 key the agent holds, limited to scopes and a robot set,
 * short-lived, revocable and logged. Off unless DELEGATION_USERS names who may approve one.
 */

export const SCOPES = ["robots:read", "robots:claim", "robots:manage", "sessions:readonly"] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_TEXT: Record<Scope, { title: string; text: string }> = {
  "robots:read": { title: "See robots", text: "List the robots below with their name, address and whether they are online." },
  "robots:claim": {
    title: "Add robots",
    text: "Add a robot to your account with its pairing code, as you would. It becomes your robot, and this agent may then use it with the rights you approve here.",
  },
  "robots:manage": { title: "Rename and unlink robots", text: "Change your name for a robot, or unlink a robot you own. An unlinked robot needs a new pairing code on the robot." },
  "sessions:readonly": {
    title: "Look at a robot's own app, read-only",
    text: "Open the robot's web interface as a viewer: status pages and live data only. It can never drive, mow, change settings or edit maps.",
  },
};

export const TTL_CHOICES = [3600, 8 * 3600, 86400, 7 * 86400, 30 * 86400] as const;
export const DEFAULT_TTL = 86400;
export const MAX_ACTIVE_DELEGATIONS = 5;
export const CALLS_PER_HOUR = 120;
export const CLAIMS_PER_HOUR = 10;
export const MAX_CLAIMED_ROBOTS = 10;
export const WRONG_CODES_PER_HOUR = 5;
/**
 * Read-only grants per delegation per robot and hour. Each becomes a 12-hour session on the robot,
 * whose session table is shared by everyone (1,024), so a delegate must not be able to fill it and
 * lock the owner out (security review 14). The CLI reuses a session for 11 hours.
 */
export const GRANTS_PER_ROBOT_PER_HOUR = 6;
/**
 * Expired delegations and activity are kept this long. A revoked delegation is kept for good, as
 * a record that its key may never be approved again (security review 14): a key is revoked when
 * it may have been copied.
 */
export const DELEGATION_RETENTION_SECONDS = 90 * 86400;
const LAST_USED_REFRESH_SECONDS = 15 * 60;
const EVENTS_SHOWN = 200;

function userList(env: Env): string[] {
  return (env.DELEGATION_USERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function delegationEnabled(env: Env): boolean {
  return userList(env).length > 0;
}

/** Whether this person may approve and use delegations (`gh:<id>` entries, or `*`). */
export function delegationAllowed(env: Env, userId: string): boolean {
  const list = userList(env);
  return list.includes("*") || list.includes(userId.toLowerCase());
}

/** Known scopes in canonical order, or null if any is unknown. */
export function parseScopes(raw: string[]): Scope[] | null {
  const want = new Set(raw.map((s) => s.trim()).filter(Boolean));
  for (const s of want) if (!(SCOPES as readonly string[]).includes(s)) return null;
  return SCOPES.filter((s) => want.has(s));
}

function hasScope(d: { scopes: string }, s: Scope): boolean {
  return d.scopes.split(" ").includes(s);
}

/** SQL condition: delegation `alias` has scope `s` (scopes are space-separated). */
function scopeSql(alias: string, s: Scope): string {
  return `(' ' || ${alias}.scopes || ' ') LIKE '% ${s} %'`;
}

function ttlText(s: number): string {
  if (s % 86400 === 0) return s === 86400 ? "24 hours" : `${s / 86400} days`;
  return s === 3600 ? "1 hour" : `${s / 3600} hours`;
}

function when(t: number): string {
  return `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

interface DelegationRow {
  delegation_id: string;
  user_id: string;
  public_key: string;
  name: string;
  scopes: string;
  ttl_seconds: number;
  created_at: number;
  approved_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

function loadDelegation(env: Env, id: string): Promise<DelegationRow | null> {
  return env.DB.prepare("SELECT * FROM delegations WHERE delegation_id = ?").bind(id).first<DelegationRow>();
}

function activeCount(env: Env, userId: string, except: string, now: number) {
  return env.DB.prepare("SELECT COUNT(*) AS n FROM delegations WHERE user_id = ? AND delegation_id != ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(userId, except, now)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0);
}

/** Ends a delegation now. Returns whether this call revoked it. */
export async function revokeDelegation(env: Env, id: string, userId: string, actor: "agent" | "person" | "app"): Promise<boolean> {
  const now = nowSeconds();
  const [upd] = await env.DB.batch([
    env.DB.prepare("UPDATE delegations SET revoked_at = ? WHERE delegation_id = ? AND user_id = ? AND revoked_at IS NULL").bind(now, id, userId),
    env.DB.prepare("INSERT INTO delegation_events (delegation_id, at, actor, action, outcome) SELECT ?, ?, ?, 'revoke', 'ok' WHERE changes() > 0").bind(id, now, actor),
  ]);
  if (upd?.meta.changes === 1) console.log("delegation: revoked", id, "by", actor, "for", userId);
  return upd?.meta.changes === 1;
}

/** Statements that revoke every delegation of a person (admin removal), with an activity entry. */
export function revokeAllStatements(env: Env, userId: string, now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT INTO delegation_events (delegation_id, at, actor, action, outcome)
       SELECT delegation_id, ?2, 'admin', 'revoke', 'ok' FROM delegations WHERE user_id = ?1 AND revoked_at IS NULL`,
    ).bind(userId, now),
    env.DB.prepare("UPDATE delegations SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(now, userId),
  ];
}

export function cleanupStatements(env: Env, now: number): D1PreparedStatement[] {
  const before = now - DELEGATION_RETENTION_SECONDS;
  return [
    env.DB.prepare("DELETE FROM delegation_events WHERE at < ?").bind(before),
    env.DB.prepare("DELETE FROM delegations WHERE revoked_at IS NULL AND expires_at < ?").bind(before),
    env.DB.prepare("DELETE FROM delegation_robots WHERE delegation_id NOT IN (SELECT delegation_id FROM delegations WHERE revoked_at IS NULL)"),
  ];
}

/**
 * The robot's members as delegates: `dlg:<id>` as a viewer for every active delegation with
 * sessions:readonly that has this robot in its set, while the person who approved it is one of
 * `memberIds` (members with access). The robot caps their sessions at viewer.
 */
export async function delegateMembers(env: Env, robotId: string, memberIds: Set<string>): Promise<{ userId: string; role: "viewer" }[]> {
  if (!delegationEnabled(env)) return [];
  const rows = await env.DB.prepare(
    `SELECT d.delegation_id, d.user_id FROM delegation_robots dr JOIN delegations d ON d.delegation_id = dr.delegation_id
     WHERE dr.robot_id = ? AND d.revoked_at IS NULL AND d.expires_at > ? AND ${scopeSql("d", "sessions:readonly")}
     ORDER BY d.delegation_id LIMIT 50`,
  )
    .bind(robotId, nowSeconds())
    .all<{ delegation_id: string; user_id: string }>();
  return rows.results
    .filter((r) => memberIds.has(r.user_id) && delegationAllowed(env, r.user_id))
    .map((r) => ({ userId: `dlg:${r.delegation_id}`, role: "viewer" as const }));
}

/** robotId -> name of the delegation that added it, for the robots page. */
export async function addedByDelegate(env: Env, userId: string): Promise<Map<string, string>> {
  if (!delegationEnabled(env)) return new Map();
  const rows = await env.DB.prepare(
    `SELECT dr.robot_id, d.name FROM delegation_robots dr JOIN delegations d ON d.delegation_id = dr.delegation_id
     WHERE d.user_id = ? AND dr.via = 'claim'`,
  )
    .bind(userId)
    .all<{ robot_id: string; name: string }>();
  return new Map(rows.results.map((r) => [r.robot_id, r.name]));
}

// --- Browser: consent, robots page section, activity, renew, revoke ---------------------------

interface ConsentParams {
  publicKey: string;
  /** The signed request, carried through the form unchanged. */
  request: string;
  delegateId: string;
  name: string;
  requested: Scope[];
  ttl: number;
}

/** How long a consent link is valid after the CLI made it. */
export const REQUEST_MAX_AGE_SECONDS = 30 * 60;

/**
 * The consent link's parameters, or a reason it is not valid. The link carries `key` and `req`, a
 * request signed by that key naming the account it is for, the agent's name, the scopes and the
 * duration (security review 14): nobody but that account can approve it, and nobody can change
 * what it asks for without the key.
 */
async function readConsentParams(env: Env, get: (k: string) => string | null, user: SessionUser): Promise<ConsentParams | string> {
  const key = get("key") ?? "";
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(key);
  } catch {
    return "The link does not contain a valid key.";
  }
  if (raw.length !== 32) return "The link does not contain a valid key.";
  const delegateId = await deriveDelegateId(raw);
  let c: Record<string, unknown>;
  try {
    const parsed = parseJws(get("req") ?? "");
    if (parsed.header.alg !== "EdDSA" || parsed.header.typ !== "mc-delegate-request+jwt") throw new Error();
    if (!(await verifyJws(parsed, await importEd25519Public(raw)))) throw new Error();
    c = parsed.payload;
  } catch {
    return "The link is not signed by the agent's key. Run mc-delegate request again and use the new link.";
  }
  const now = nowSeconds();
  if (c.iss !== delegateId || c.aud !== env.RELAY_ORIGIN) return "The link is not for this key or this site.";
  if (typeof c.iat !== "number" || typeof c.exp !== "number" || c.exp - c.iat > REQUEST_MAX_AGE_SECONDS || c.iat > now + SKEW_SECONDS || c.exp + SKEW_SECONDS < now) {
    return "The link has expired. Run mc-delegate request again and use the new link.";
  }
  if (typeof c.account !== "string" || c.account.toLowerCase() !== user.login.toLowerCase()) {
    return `This link is for the account @${typeof c.account === "string" ? c.account.slice(0, 39) : "?"}, and you are signed in as @${user.login}. Only that account can approve it.`;
  }
  const name = cleanLabel(c.name, 40);
  if (!name) return "The link does not name the agent.";
  const requested = typeof c.scopes === "string" ? parseScopes(c.scopes.split(/[\s,]+/)) : null;
  if (requested === null) return "The link asks for a right that cannot be given to an agent. Only the rights listed in the documentation exist.";
  if (requested.length === 0) return "The link does not ask for any right.";
  const t = c.ttl ?? DEFAULT_TTL;
  const ttl = typeof t === "number" && Number.isInteger(t) && t > 0 ? ([...TTL_CHOICES].reverse().find((x) => x <= t) ?? TTL_CHOICES[0]) : DEFAULT_TTL;
  return { publicKey: key, request: get("req")!, delegateId, name, requested, ttl };
}

interface MemberRobot {
  robot_id: string;
  name: string | null;
  label: string | null;
  role: string;
}

function memberRobots(env: Env, userId: string): Promise<MemberRobot[]> {
  return env.DB.prepare(
    `SELECT r.robot_id, r.name, m.label, m.role FROM members m JOIN robots r ON r.robot_id = m.robot_id
     WHERE m.user_id = ? AND r.status = 'claimed' ORDER BY m.created_at`,
  )
    .bind(userId)
    .all<MemberRobot>()
    .then((r) => r.results);
}

function robotSet(env: Env, id: string): Promise<Map<string, "consent" | "claim">> {
  return env.DB.prepare("SELECT robot_id, via FROM delegation_robots WHERE delegation_id = ?")
    .bind(id)
    .all<{ robot_id: string; via: "consent" | "claim" }>()
    .then((r) => new Map(r.results.map((x) => [x.robot_id, x.via])));
}

function stateText(d: DelegationRow, now: number): string {
  if (d.revoked_at !== null) return `Revoked ${when(d.revoked_at)}`;
  if (d.expires_at <= now) return `Expired ${when(d.expires_at)}`;
  return `Active until ${when(d.expires_at)}`;
}

function scopeTitles(scopes: string): string {
  return (parseScopes(scopes.split(" ")) ?? []).map((s) => SCOPE_TEXT[s].title).join(", ") || "nothing";
}

export interface DelegationPageDeps {
  pageUser: (u: SessionUser) => PageUser;
  loginRedirect: (u: URL) => Response;
  notFound: () => Response;
  redirect: (location: string, status?: number) => Response;
}

export function isDelegationPath(pathname: string): boolean {
  return pathname === "/delegate/authorize" || /^\/delegations\/[^/]+(\/(renew|revoke))?$/.test(pathname);
}

/** /delegate/authorize and /delegations/*. The caller has checked the Origin of a POST. */
export async function handleDelegationBrowser(
  request: Request,
  env: Env,
  url: URL,
  user: SessionUser | null,
  deps: DelegationPageDeps,
): Promise<Response> {
  if (!delegationEnabled(env)) return deps.notFound();
  if (!user) return request.method === "GET" ? deps.loginRedirect(url) : deps.redirect("/login", 303);
  if (!delegationAllowed(env, user.id)) return deps.notFound();
  const pu = deps.pageUser(user);

  if (url.pathname === "/delegate/authorize") {
    if (request.method === "GET") return consentPage(env, user, pu, await readConsentParams(env, (k) => url.searchParams.get(k), user));
    if (request.method === "POST") return approve(env, request, user, pu);
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  const m = /^\/delegations\/([^/]+)(?:\/(renew|revoke))?$/.exec(url.pathname)!;
  const id = m[1]!;
  if (!DELEGATE_ID.test(id)) return deps.notFound();
  if (!m[2]) return request.method === "GET" ? activityPage(env, user, pu, id, deps) : new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (m[2] === "revoke") return (await revokeDelegation(env, id, user.id, "person")) ? deps.redirect("/?notice=delegation_revoked", 303) : deps.notFound();
  return renew(env, user, pu, id, deps);
}

function revokedKeyPage(revokedAt: number, pu: PageUser): Response {
  return errorPage(
    "This key was revoked",
    `This agent's key was revoked on ${when(revokedAt)}, and a revoked key can never be approved again, because it may have been copied. On the agent's machine, create a new key with mc-delegate --profile <new name> init, then request access with it.`,
    409,
    pu,
  );
}

function errorPage(title: string, message: string, status: number, pu: PageUser): Response {
  return page(title, html`<h1>${title}</h1><p class="error">${message}</p><p><a href="/">Back to my robots</a></p>`, status, {}, pu);
}

async function consentPage(env: Env, user: SessionUser, pu: PageUser, p: ConsentParams | string): Promise<Response> {
  if (typeof p === "string") return errorPage("This link is not valid", p, 400, pu);
  const now = nowSeconds();
  const existing = await loadDelegation(env, p.delegateId);
  if (existing && existing.user_id !== user.id) return errorPage("This key belongs to another account", "Create a new key on the agent's machine (mc-delegate init with a new profile) and try again.", 409, pu);
  if (existing?.revoked_at) return revokedKeyPage(existing.revoked_at, pu);
  if ((await activeCount(env, user.id, p.delegateId, now)) >= MAX_ACTIVE_DELEGATIONS) {
    return errorPage("Too many AI agents", `You have ${MAX_ACTIVE_DELEGATIONS} active AI agents already. Revoke one on your robots page first.`, 403, pu);
  }
  const robots = await memberRobots(env, user.id);
  const set = existing ? await robotSet(env, p.delegateId) : new Map<string, "consent" | "claim">();
  const hidden = (k: string, v: string) => html`<input type="hidden" name="${k}" value="${v}">`;
  const claimNote = p.requested.includes("robots:claim")
    ? html`<p class="muted">At most ${CLAIMS_PER_HOUR} new robots an hour, and ${MAX_CLAIMED_ROBOTS} it added still linked at a time. Your own robot limit applies.</p>`
    : "";
  return page(
    "Let an AI agent act for you",
    html`<h1>Let an AI agent act for you?</h1>
<div class="panel invitee"><span class="avatar big" aria-hidden="true">${p.name.charAt(0).toUpperCase()}</span>
<div><strong>${p.name}</strong><span class="muted">name chosen by the agent · acts as @${user.login}</span></div></div>
<p>Key fingerprint: <code>${fingerprint(p.delegateId)}</code>. It must be exactly the fingerprint your terminal shows.</p>
${existing ? html`<p class="notice" role="status">This key already has access (${stateText(existing, now)}: ${scopeTitles(existing.scopes)}). Approving replaces its rights, its robots and its expiry.</p>` : ""}
<p class="error">Only continue if you started this yourself, a moment ago, in your own terminal. If someone sent you this link, close this page.</p>
<form method="post" action="/delegate/authorize">
${hidden("key", p.publicKey)}${hidden("req", p.request)}
<h2>What it may do</h2>
<ul class="consent">${p.requested.map(
      (s) => html`<li><label><input type="checkbox" name="scope" value="${s}" checked> <strong>${SCOPE_TEXT[s].title}</strong> <code>${s}</code></label><p class="muted">${SCOPE_TEXT[s].text}</p></li>`,
    )}</ul>
${claimNote}
<p class="muted">It can never drive a robot, mow, change robot settings, share robots, manage invitations or approve more access for itself.</p>
<h2>Which robots</h2>
${
  robots.length === 0
    ? html`<p class="muted">You have no robots yet.</p>`
    : html`<ul class="consent">${robots.map((r) =>
        set.get(r.robot_id) === "claim"
          ? html`<li><span><strong>${r.label ?? r.name ?? r.robot_id}</strong> <span class="muted">added by this agent; stays until it is unlinked</span></span></li>`
          : html`<li><label><input type="checkbox" name="robot" value="${r.robot_id}"${set.get(r.robot_id) === "consent" ? html` checked` : ""}> <strong>${r.label ?? r.name ?? r.robot_id}</strong> <span class="muted">${r.role === "owner" ? "Owner" : "Viewer"} · ${r.robot_id}</span></label></li>`,
      )}</ul>`
}
<p class="muted">None is ticked unless you tick it. Robots it adds itself are always included.${p.requested.includes("robots:manage") ? " With Rename and unlink robots, it can unlink every robot you tick that you own: only tick a real mower if you need to." : ""}</p>
<h2>For how long</h2>
<p><label for="ttl">Access ends after</label> <select id="ttl" name="ttl">${TTL_CHOICES.map((t) => html`<option value="${String(t)}"${t === p.ttl ? html` selected` : ""}>${ttlText(t)}</option>`)}</select></p>
<p class="muted">You can renew it, or revoke it at any time, under AI agents on your robots page. Everything it does is listed there.</p>
<p><label><input type="checkbox" name="confirm" value="yes" required> I started this myself, just now, and the fingerprint matches my terminal.</label></p>
<p class="actions"><button class="primary" name="decision" value="allow">Approve</button> <button name="decision" value="deny" formnovalidate>Cancel</button></p>
</form>`,
    200,
    {},
    pu,
  );
}

async function approve(env: Env, request: Request, user: SessionUser, pu: PageUser): Promise<Response> {
  const ct = request.headers.get("Content-Type") ?? "";
  const text = ct.startsWith("application/x-www-form-urlencoded") ? await readBodyText(request, 8192) : null;
  if (text === null) return errorPage("Not approved", "The form was not filled in correctly.", 400, pu);
  const form = new URLSearchParams(text);
  if (form.get("decision") !== "allow") {
    return page("Not approved", html`<h1>Not approved</h1><p>Nothing was changed. The agent has no new access.</p><p><a href="/">Back to my robots</a></p>`, 200, {}, pu);
  }
  const p = await readConsentParams(env, (k) => form.get(k), user);
  if (typeof p === "string") return errorPage("Not approved", p, 400, pu);
  if (form.get("confirm") !== "yes") return errorPage("Not approved", "Tick the box that says you started this yourself.", 400, pu);
  const ttl = Number(form.get("ttl"));
  if (!(TTL_CHOICES as readonly number[]).includes(ttl)) return errorPage("Not approved", "Choose how long the access lasts.", 400, pu);
  const chosen = parseScopes(form.getAll("scope"));
  const scopes = chosen?.filter((s) => p.requested.includes(s)) ?? [];
  if (chosen === null || scopes.length !== chosen.length) return errorPage("Not approved", "The form was not filled in correctly.", 400, pu);
  if (scopes.length === 0) return errorPage("Not approved", "Tick at least one thing the agent may do, or press Cancel.", 400, pu);
  const robots = [...new Set(form.getAll("robot"))];
  if (robots.length > 100 || !robots.every(isRobotId)) return errorPage("Not approved", "The form was not filled in correctly.", 400, pu);
  const mine = new Set((await memberRobots(env, user.id)).map((r) => r.robot_id));
  if (!robots.every((r) => mine.has(r))) return errorPage("Not approved", "One of the robots is not yours any more. Load the page again.", 409, pu);

  const now = nowSeconds();
  const id = p.delegateId;
  // Every statement after the first runs only if this approval was stored (the same approved_at).
  const stored = "EXISTS (SELECT 1 FROM delegations WHERE delegation_id = ?1 AND user_id = ?2 AND approved_at = ?3 AND revoked_at IS NULL)";
  const steps = [
    // At most MAX_ACTIVE_DELEGATIONS active per person, and a key belongs to one person, in the
    // same statement. A revoked key is never approved again.
    env.DB.prepare(
      `INSERT INTO delegations (delegation_id, user_id, public_key, name, scopes, ttl_seconds, created_at, approved_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8
       WHERE (SELECT COUNT(*) FROM delegations WHERE user_id = ?2 AND delegation_id != ?1 AND revoked_at IS NULL AND expires_at > ?7) < ?9
       ON CONFLICT(delegation_id) DO UPDATE SET name = excluded.name, scopes = excluded.scopes, ttl_seconds = excluded.ttl_seconds,
         approved_at = excluded.approved_at, expires_at = excluded.expires_at
       WHERE delegations.user_id = excluded.user_id AND delegations.public_key = excluded.public_key AND delegations.revoked_at IS NULL`,
    ).bind(id, user.id, p.publicKey, p.name, scopes.join(" "), ttl, now, now + ttl, MAX_ACTIVE_DELEGATIONS),
    env.DB.prepare(`DELETE FROM delegation_robots WHERE delegation_id = ?1 AND via = 'consent' AND ${stored}`).bind(id, user.id, now),
    ...robots.map((r) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO delegation_robots (delegation_id, robot_id, via, added_at)
         SELECT ?1, ?4, 'consent', ?3 WHERE ${stored}
           AND EXISTS (SELECT 1 FROM members m JOIN robots o ON o.robot_id = m.robot_id WHERE m.robot_id = ?4 AND m.user_id = ?2 AND o.status = 'claimed')`,
      ).bind(id, user.id, now, r),
    ),
    env.DB.prepare(
      `INSERT INTO delegation_events (delegation_id, at, actor, action, outcome, detail)
       SELECT ?1, ?3, 'person', 'approve', 'ok', ?4 WHERE ${stored}`,
    ).bind(id, user.id, now, `${scopes.join(" ")}; ${robots.length} robots ticked; ${ttlText(ttl)}`),
  ];
  const [ins] = await env.DB.batch(steps);
  if (ins?.meta.changes !== 1) {
    const owner = await loadDelegation(env, id);
    if (owner?.user_id === user.id && owner.revoked_at) return revokedKeyPage(owner.revoked_at, pu);
    return owner && owner.user_id !== user.id
      ? errorPage("Not approved", "This key belongs to another account.", 409, pu)
      : errorPage("Not approved", `You have ${MAX_ACTIVE_DELEGATIONS} active AI agents already. Revoke one on your robots page first.`, 403, pu);
  }
  console.log("delegation: approved", id, "for", user.id, scopes.join(" "));
  return page(
    "Approved",
    html`<h1>Approved</h1><p><strong>${p.name}</strong> may act for you until ${when(now + ttl)}: ${scopeTitles(scopes.join(" "))}.</p>
<p>Go back to your terminal. You can revoke it at any time under AI agents on <a href="/">your robots page</a>.</p>`,
    200,
    {},
    pu,
  );
}

async function renew(env: Env, user: SessionUser, pu: PageUser, id: string, deps: DelegationPageDeps): Promise<Response> {
  const now = nowSeconds();
  const [upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE delegations SET approved_at = ?3, expires_at = ?3 + ttl_seconds
       WHERE delegation_id = ?1 AND user_id = ?2 AND revoked_at IS NULL
         AND (SELECT COUNT(*) FROM delegations WHERE user_id = ?2 AND delegation_id != ?1 AND revoked_at IS NULL AND expires_at > ?3) < ?4`,
    ).bind(id, user.id, now, MAX_ACTIVE_DELEGATIONS),
    env.DB.prepare("INSERT INTO delegation_events (delegation_id, at, actor, action, outcome) SELECT ?, ?, 'person', 'renew', 'ok' WHERE changes() > 0").bind(id, now),
  ]);
  if (upd?.meta.changes === 1) return deps.redirect("/?notice=delegation_renewed", 303);
  const d = await loadDelegation(env, id);
  if (!d || d.user_id !== user.id || d.revoked_at !== null) return deps.notFound();
  return errorPage("Not renewed", `You have ${MAX_ACTIVE_DELEGATIONS} active AI agents already. Revoke one first.`, 403, pu);
}

async function activityPage(env: Env, user: SessionUser, pu: PageUser, id: string, deps: DelegationPageDeps): Promise<Response> {
  const d = await loadDelegation(env, id);
  if (!d || d.user_id !== user.id) return deps.notFound();
  const events = await env.DB.prepare(
    "SELECT at, actor, action, robot_id, outcome, detail FROM delegation_events WHERE delegation_id = ? ORDER BY id DESC LIMIT ?",
  )
    .bind(id, EVENTS_SHOWN)
    .all<{ at: number; actor: string; action: string; robot_id: string | null; outcome: string; detail: string | null }>();
  const set = await robotSet(env, id);
  const names = new Map((await memberRobots(env, user.id)).map((r) => [r.robot_id, r.label ?? r.name ?? r.robot_id]));
  const now = nowSeconds();
  return page(
    "AI agent activity",
    html`<h1>${d.name}</h1>
<p class="muted">Key <code>${fingerprint(d.delegation_id)}</code> · ${stateText(d, now)} · approved ${when(d.approved_at)}${d.last_used_at ? ` · last used ${when(d.last_used_at)}` : ""}</p>
<p>May: ${scopeTitles(d.scopes)}.</p>
<p>Robots: ${set.size === 0 ? "none" : [...set].map(([r, via]) => `${names.get(r) ?? r}${via === "claim" ? " (added by it)" : ""}`).join(", ")}.</p>
<h2>Activity</h2>
${
  events.results.length === 0
    ? html`<p class="muted">Nothing yet.</p>`
    : html`<div class="table-wrap"><table class="activity"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Robot</th><th>Result</th><th>Detail</th></tr></thead><tbody>${events.results.map(
        (e) => html`<tr><td>${when(e.at)}</td><td>${e.actor === "agent" ? "the agent" : e.actor === "person" ? "you" : e.actor === "app" ? "you, in the app" : "admin"}</td><td>${e.action}</td><td>${e.robot_id ? (names.get(e.robot_id) ?? e.robot_id) : ""}</td><td>${e.outcome}</td><td>${e.detail ?? ""}</td></tr>`,
      )}</tbody></table></div>`
}
<p class="muted">The last ${EVENTS_SHOWN} entries, kept for 90 days. Robot names come from the robots and are not checked.</p>
<p><a href="/">Back to my robots</a></p>`,
    200,
    {},
    pu,
  );
}

/** The "AI agents" section of the robots page. Nothing unless this person may delegate. */
export async function delegationsHtml(env: Env, user: SessionUser): Promise<SafeHtml | string> {
  if (!delegationEnabled(env) || !delegationAllowed(env, user.id)) return "";
  const rows = await env.DB.prepare(
    `SELECT d.*, (SELECT COUNT(*) FROM delegation_robots dr WHERE dr.delegation_id = d.delegation_id) AS robots
     FROM delegations d WHERE d.user_id = ? AND (d.revoked_at IS NULL OR d.revoked_at > ?) ORDER BY d.created_at`,
  )
    .bind(user.id, nowSeconds() - DELEGATION_RETENTION_SECONDS)
    .all<DelegationRow & { robots: number }>();
  const now = nowSeconds();
  return html`<h2>AI agents</h2>
${
  rows.results.length === 0
    ? html`<p class="muted">No AI agent can act for you. To let one, run <code>mc-delegate request</code> on its machine (<a href="https://github.com/liltaket/mowgli-connect/blob/main/docs/agent-delegation.md">how</a>).</p>`
    : html`<ul class="people">${rows.results.map(
        (d) => html`<li class="person"><span class="avatar" aria-hidden="true">${d.name.charAt(0).toUpperCase()}</span>
<div class="person-main"><span class="person-name">${d.name}</span><span class="meta"><span>${stateText(d, now)}</span><span>${scopeTitles(d.scopes)}</span><span>${d.robots} ${d.robots === 1 ? "robot" : "robots"}</span><span>Key ${fingerprint(d.delegation_id)}</span>${d.last_used_at ? html`<span>Last used ${when(d.last_used_at)}</span>` : ""}</span></div>
<div class="actions"><a class="btn small" href="/delegations/${d.delegation_id}">Activity</a>${
          d.revoked_at === null
            ? html` <form method="post" action="/delegations/${d.delegation_id}/renew"><button class="small">Renew for ${ttlText(d.ttl_seconds)}</button></form> <form method="post" action="/delegations/${d.delegation_id}/revoke"><button class="danger small">Revoke</button></form>`
            : ""
        }</div></li>`,
      )}</ul>`
}`;
}

// --- The delegate API: /v1/delegate/* -------------------------------------------------------

interface Auth {
  d: DelegationRow;
  user: SessionUser;
  /** The body as strict UTF-8 (no BOM), or null if it is not. */
  body: string | null;
  now: number;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function authFailure(e: DelegateAuthError): Response {
  return json({ error: "invalid_assertion", detail: e.code }, 401, { "WWW-Authenticate": 'MC-Delegate error="invalid_token"' });
}

/**
 * Verifies the signed call (over the exact body bytes), the delegation, the hourly call limit
 * (read only, so a delegation over its limit writes nothing more, its replay record included;
 * security review 14), the jti and its person's access.
 */
async function authenticate(request: Request, env: Env, url: URL, opts: { skipLimit?: boolean } = {}): Promise<Auth | Response> {
  const body = await readBodyBytes(request, 4096);
  if (body === null) return json({ error: "too_large" }, 413);
  let row: DelegationRow | null = null;
  let a;
  try {
    a = await verifyDelegateAssertion({
      authorization: request.headers.get("Authorization"),
      method: request.method,
      htu: `${env.RELAY_ORIGIN}${url.pathname}`,
      aud: env.RELAY_ORIGIN,
      body,
      now: nowSeconds(),
      resolveKey: async (iss) => {
        row = await loadDelegation(env, iss);
        return row ? b64urlDecode(row.public_key) : null;
      },
    });
  } catch (e) {
    if (e instanceof DelegateAuthError) return authFailure(e);
    throw e;
  }
  const d = row as DelegationRow | null;
  if (!d) return authFailure(new DelegateAuthError("unknown_delegate"));
  const now = nowSeconds();
  if (d.revoked_at !== null) return json({ error: "delegation_revoked" }, 401);
  if (d.expires_at <= now) return json({ error: "delegation_expired" }, 401);
  if (!opts.skipLimit) {
    const calls = await env.DB.prepare("SELECT COUNT(*) AS n FROM delegation_events WHERE delegation_id = ? AND actor = 'agent' AND at > ?")
      .bind(d.delegation_id, now - 3600)
      .first<{ n: number }>();
    if ((calls?.n ?? 0) >= CALLS_PER_HOUR) return RATE_LIMITED();
  }
  const seen = await env.DB.prepare("INSERT OR IGNORE INTO jti_seen (robot_id, jti, expires_at) VALUES (?, ?, ?)")
    .bind(`dlg:${d.delegation_id}`, a.jti, a.exp + SKEW_SECONDS)
    .run();
  if (seen.meta.changes !== 1) return authFailure(new DelegateAuthError("replayed_jti"));
  const user = await env.DB.prepare("SELECT id, login, name FROM users WHERE id = ?").bind(d.user_id).first<SessionUser>();
  if (!user || !delegationAllowed(env, user.id) || !(await isUserAllowed(env, user.id, user.login))) return json({ error: "no_access" }, 403);
  if (d.last_used_at === null || now - d.last_used_at > LAST_USED_REFRESH_SECONDS) {
    await env.DB.prepare("UPDATE delegations SET last_used_at = ? WHERE delegation_id = ?").bind(now, d.delegation_id).run();
  }
  let text: string | null;
  try {
    text = STRICT_UTF8.decode(body);
  } catch {
    text = null;
  }
  return { d, user, body: text, now };
}

const CALL_GATE = `(SELECT COUNT(*) FROM delegation_events WHERE delegation_id = ?1 AND actor = 'agent' AND at > ?2 - 3600) < ${CALLS_PER_HOUR}`;

/**
 * Writes the activity entry for a call, in the same statement as the hourly call limit (and any
 * `extra` condition). Returns its id, or null when a limit is reached (nothing written).
 */
async function record(
  env: Env,
  a: Auth,
  action: string,
  robotId: string | null,
  outcome: string,
  detail: string | null = null,
  extra = "",
): Promise<number | null> {
  const row = await env.DB.prepare(
    `INSERT INTO delegation_events (delegation_id, at, actor, action, robot_id, outcome, detail)
     SELECT ?1, ?2, 'agent', ?3, ?4, ?5, ?6 WHERE ${CALL_GATE} ${extra} RETURNING id`,
  )
    .bind(a.d.delegation_id, a.now, action, robotId, outcome, detail?.slice(0, 200) ?? null)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function finish(env: Env, id: number, outcome: string, robotId: string | null = null, detail: string | null = null): Promise<void> {
  await env.DB.prepare("UPDATE delegation_events SET outcome = ?, robot_id = COALESCE(?, robot_id), detail = COALESCE(?, detail) WHERE id = ?")
    .bind(outcome, robotId, detail?.slice(0, 200) ?? null, id)
    .run();
}

const RATE_LIMITED = () => json({ error: "rate_limited" }, 429, { "Retry-After": "300" });

interface SetRobot {
  robot_id: string;
  name: string | null;
  hostname: string | null;
  session_epoch: number;
  tunnel_id: string | null;
  first_online_at: number | null;
  allow_teleop: number | null;
  agent_version: string | null;
  role: "owner" | "viewer";
  label: string | null;
  via: "consent" | "claim";
}

const SET_ROBOTS = `SELECT r.robot_id, r.name, r.hostname, r.session_epoch, r.tunnel_id, r.first_online_at, r.allow_teleop, r.agent_version, m.role, m.label, dr.via
  FROM delegation_robots dr JOIN robots r ON r.robot_id = dr.robot_id JOIN members m ON m.robot_id = dr.robot_id AND m.user_id = ?2
  WHERE dr.delegation_id = ?1 AND r.status = 'claimed'`;

/** A robot in the delegation's set that the person is still a member of, or null. */
function setRobot(env: Env, a: Auth, robotId: string): Promise<SetRobot | null> {
  return env.DB.prepare(`${SET_ROBOTS} AND dr.robot_id = ?3`).bind(a.d.delegation_id, a.user.id, robotId).first<SetRobot>();
}

async function readJson(a: Auth, request: Request): Promise<Record<string, unknown> | null> {
  if (a.body === null || !(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return null;
  try {
    const v: unknown = JSON.parse(a.body);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function markFirstOnline(env: Env, robotId: string): Promise<void> {
  await env.DB.prepare("UPDATE robots SET first_online_at = ? WHERE robot_id = ? AND first_online_at IS NULL").bind(nowSeconds(), robotId).run();
}

const ROUTES: Record<string, { method: "GET" | "POST"; scope: Scope | null; action: string }> = {
  "/v1/delegate/self": { method: "GET", scope: null, action: "self" },
  "/v1/delegate/robots": { method: "GET", scope: "robots:read", action: "list" },
  "/v1/delegate/claim": { method: "POST", scope: "robots:claim", action: "claim" },
  "/v1/delegate/revoke": { method: "POST", scope: null, action: "revoke" },
  label: { method: "POST", scope: "robots:manage", action: "label" },
  unlink: { method: "POST", scope: "robots:manage", action: "unlink" },
  grant: { method: "POST", scope: "sessions:readonly", action: "grant" },
};

/** /v1/delegate/*: the signed JSON API for delegates. Returns null for other paths. */
export async function handleDelegateApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/delegate/")) return null;
  if (!delegationEnabled(env)) return json({ error: "not_found" }, 404);
  const robotPath = /^\/v1\/delegate\/robots\/([^/]+)\/(label|unlink|grant)$/.exec(url.pathname);
  const route = robotPath ? ROUTES[robotPath[2]!] : Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
  if (!route) return json({ error: "not_found" }, 404);
  if (request.method !== route.method) return json({ error: "method_not_allowed" }, 405, { Allow: route.method });

  // Revoking itself works even over the call limit; afterwards the key can do nothing.
  const a = await authenticate(request, env, url, { skipLimit: route.action === "revoke" });
  if (a instanceof Response) return a;
  if (route.action === "revoke") {
    await revokeDelegation(env, a.d.delegation_id, a.user.id, "agent");
    return json({ ok: true });
  }
  // Every authenticated call below writes one activity entry, which is also what the call limit
  // counts, so no answer (not even a 400) comes without being counted.
  const robotId = robotPath ? robotPath[1]! : null;
  if (robotId !== null && !isRobotId(robotId)) {
    return (await record(env, a, route.action, null, "not_found")) === null ? RATE_LIMITED() : json({ error: "not_found" }, 404);
  }

  if (route.scope && !hasScope(a.d, route.scope)) {
    // Logged, so an agent trying what it may not do shows up in the activity.
    return (await record(env, a, route.action, robotId, "denied", `needs ${route.scope}`)) === null
      ? RATE_LIMITED()
      : json({ error: "scope_required", scope: route.scope }, 403);
  }

  if (route.action === "self") {
    if ((await record(env, a, "self", null, "ok")) === null) return RATE_LIMITED();
    const set = await robotSet(env, a.d.delegation_id);
    return json({
      delegateId: a.d.delegation_id,
      name: a.d.name,
      login: a.user.login,
      scopes: a.d.scopes.split(" "),
      robots: [...set.keys()],
      expiresAt: a.d.expires_at,
    });
  }

  if (route.action === "list") {
    if ((await record(env, a, "list", null, "ok")) === null) return RATE_LIMITED();
    const rows = await env.DB.prepare(`${SET_ROBOTS} ORDER BY dr.added_at`).bind(a.d.delegation_id, a.user.id).all<SetRobot>();
    const prov = createProvisioner(env);
    const latest = await latestAgentSha(env);
    const robots = await Promise.all(
      rows.results.map(async (r, i) => {
        const online = i < 20 && r.tunnel_id && prov.connected ? await prov.connected(r.tunnel_id) : null;
        if (online && r.first_online_at === null) await markFirstOnline(env, r.robot_id);
        return {
          robotId: r.robot_id,
          name: r.label ?? r.name ?? r.robot_id,
          hostname: r.hostname,
          role: r.role,
          online,
          joystick: r.allow_teleop === null ? null : r.allow_teleop === 1,
          updateAvailable: r.role === "owner" ? updateAvailable(r.agent_version, latest) : null,
          addedByDelegate: r.via === "claim",
        };
      }),
    );
    return json({ robots });
  }

  if (route.action === "claim") return claim(env, a, request);

  // label, unlink, grant: robots in the set only; anything else looks like an unknown robot.
  const robot = await setRobot(env, a, robotId!);
  if (!robot) {
    return (await record(env, a, route.action, robotId, "not_found")) === null ? RATE_LIMITED() : json({ error: "not_found" }, 404);
  }

  if (route.action === "label") {
    const body = await readJson(a, request);
    if (!body || (body.label !== null && typeof body.label !== "string")) {
      return (await record(env, a, "label", robot.robot_id, "bad_request")) === null ? RATE_LIMITED() : json({ error: "bad_request" }, 400);
    }
    const label = cleanLabel(body.label);
    const ev = await record(env, a, "label", robot.robot_id, "pending", label ?? "(cleared)");
    if (ev === null) return RATE_LIMITED();
    const upd = await env.DB.prepare(
      `UPDATE members SET label = ?1 WHERE robot_id = ?2 AND user_id = ?3
         AND EXISTS (SELECT 1 FROM delegations WHERE delegation_id = ?4 AND revoked_at IS NULL AND expires_at > ?5)
         AND EXISTS (SELECT 1 FROM delegation_robots WHERE delegation_id = ?4 AND robot_id = ?2)`,
    )
      .bind(label, robot.robot_id, a.user.id, a.d.delegation_id, nowSeconds())
      .run();
    await finish(env, ev, upd.meta.changes === 1 ? "ok" : "failed");
    return upd.meta.changes === 1 ? json({ robotId: robot.robot_id, label }) : json({ error: "not_found" }, 404);
  }

  if (route.action === "unlink") {
    if (robot.role !== "owner") {
      return (await record(env, a, "unlink", robot.robot_id, "denied", "not the owner")) === null ? RATE_LIMITED() : json({ error: "owner_required" }, 403);
    }
    const ev = await record(env, a, "unlink", robot.robot_id, "pending", robot.label ?? robot.name);
    if (ev === null) return RATE_LIMITED();
    // The guard re-checks owner, delegation and robot set in the unlink statement itself.
    const ok = await unlinkRobot(env, createProvisioner(env), robot.robot_id, { guard: { ownerId: a.user.id, delegationId: a.d.delegation_id } });
    await finish(env, ev, ok ? "ok" : "failed");
    console.log("delegation: unlink", a.d.delegation_id, robot.robot_id, ok);
    return ok ? json({ ok: true }) : json({ error: "not_found" }, 404);
  }

  // grant (sessions:readonly): a viewer grant for the delegate's own identity.
  const ev = await record(
    env,
    a,
    "grant",
    robot.robot_id,
    "pending",
    null,
    `AND (SELECT COUNT(*) FROM delegation_events WHERE delegation_id = ?1 AND action = 'grant' AND robot_id = ?4 AND outcome IN ('ok', 'pending') AND at > ?2 - 3600) < ${GRANTS_PER_ROBOT_PER_HOUR}`,
  );
  if (ev === null) {
    return json(
      { error: "grant_limit", message: `At most ${GRANTS_PER_ROBOT_PER_HOUR} read-only sessions an hour per robot. Reuse the session you have.` },
      429,
      { "Retry-After": "600" },
    );
  }
  const now = nowSeconds();
  // The epoch is read together with proof that the delegation is still active and still has the
  // robot (security review 13): a revocation that commits first leaves nothing to read.
  const row = await env.DB.prepare(
    `SELECT r.hostname, r.session_epoch, r.tunnel_id, r.first_online_at FROM robots r
     WHERE r.robot_id = ?1 AND r.status = 'claimed'
       AND EXISTS (SELECT 1 FROM members WHERE robot_id = ?1 AND user_id = ?2)
       AND EXISTS (SELECT 1 FROM delegation_robots WHERE delegation_id = ?3 AND robot_id = ?1)
       AND EXISTS (SELECT 1 FROM delegations WHERE delegation_id = ?3 AND revoked_at IS NULL AND expires_at > ?4 AND ${scopeSql("delegations", "sessions:readonly")})`,
  )
    .bind(robot.robot_id, a.user.id, a.d.delegation_id, now)
    .first<{ hostname: string | null; session_epoch: number; tunnel_id: string | null; first_online_at: number | null }>();
  if (!row) {
    await finish(env, ev, "not_found");
    return json({ error: "not_found" }, 404);
  }
  if (!row.hostname) {
    await finish(env, ev, "robot_starting");
    return json({ error: "robot_starting" }, 503, { "Retry-After": "10" });
  }
  const prov = createProvisioner(env);
  const up = row.tunnel_id && prov.connected ? await prov.connected(row.tunnel_id) : null;
  if (up === false) {
    await finish(env, ev, "robot_offline");
    return json({ error: "robot_offline" }, 503, { "Retry-After": "5" });
  }
  if (up && row.first_online_at === null) await markFirstOnline(env, robot.robot_id);
  const name = cleanLabel(`${a.d.name} (agent for @${a.user.login})`) ?? a.d.name;
  const grant = await mintGrant(env, { robotId: robot.robot_id, userId: `dlg:${a.d.delegation_id}`, name, role: "viewer", epoch: row.session_epoch }, now);
  await finish(env, ev, "ok");
  return json({ grant, hostname: row.hostname, expiresAt: now + GRANT_TTL_SECONDS });
}

/** At most CLAIMS_PER_HOUR claims an hour, and MAX_CLAIMED_ROBOTS added robots still linked. */
const CLAIM_GATE = `AND (SELECT COUNT(*) FROM delegation_events WHERE delegation_id = ?1 AND action = 'claim' AND outcome IN ('ok', 'pending') AND at > ?2 - 3600) < ${CLAIMS_PER_HOUR}
  AND (SELECT COUNT(*) FROM delegation_robots dr JOIN robots r ON r.robot_id = dr.robot_id WHERE dr.delegation_id = ?1 AND dr.via = 'claim' AND r.status = 'claimed')
    + (SELECT COUNT(*) FROM delegation_events WHERE delegation_id = ?1 AND action = 'claim' AND outcome = 'pending' AND at > ?2 - 300) < ${MAX_CLAIMED_ROBOTS}`;

async function claim(env: Env, a: Auth, request: Request): Promise<Response> {
  const body = await readJson(a, request);
  if (!body || typeof body.code !== "string" || (body.step !== "preview" && body.step !== "confirm")) {
    return (await record(env, a, "claim", null, "bad_request")) === null ? RATE_LIMITED() : json({ error: "bad_request" }, 400);
  }
  const code = body.code.slice(0, 64);
  const label = cleanLabel(body.label);
  const budget = { key: `dlg:${a.d.delegation_id}`, perHour: WRONG_CODES_PER_HOUR };
  const failed = (status: number, message: string) => json({ error: status === 429 ? "rate_limited" : status === 403 ? "robot_limit" : status === 400 ? "invalid_code" : "claim_failed", message }, status);
  const outcomeOf = (status: number) => (status === 429 ? "rate_limited" : status === 403 ? "robot_limit" : status === 400 ? "invalid_code" : "failed");

  if (body.step === "preview") {
    const ev = await record(env, a, "claim_preview", null, "pending");
    if (ev === null) return RATE_LIMITED();
    const prev = await previewClaim(env, a.user.id, code, budget);
    if (!prev.ok) {
      await finish(env, ev, outcomeOf(prev.status));
      return failed(prev.status, prev.message);
    }
    const full = await reachedLimit(env, a.user.id);
    if (full !== null) {
      await finish(env, ev, "robot_limit", prev.robotId);
      return json({ error: "robot_limit", message: limitMessage(full) }, 403);
    }
    const plan = await planAddress(env, createProvisioner(env), prev.robotId, label ?? prev.name);
    await finish(env, ev, "ok", prev.robotId);
    return json({ robotId: prev.robotId, name: prev.name, hostname: plan?.hostname ?? null, taken: plan?.taken ?? null });
  }

  const ev = await record(env, a, "claim", null, "pending", label, CLAIM_GATE);
  if (ev === null) {
    const calls = await env.DB.prepare("SELECT COUNT(*) AS n FROM delegation_events WHERE delegation_id = ? AND actor = 'agent' AND at > ?")
      .bind(a.d.delegation_id, a.now - 3600)
      .first<{ n: number }>();
    if ((calls?.n ?? 0) >= CALLS_PER_HOUR) return RATE_LIMITED();
    return json(
      { error: "claim_limit", message: `This agent may add ${CLAIMS_PER_HOUR} robots an hour and have ${MAX_CLAIMED_ROBOTS} it added linked at a time. Unlink one, or try later.` },
      429,
      { "Retry-After": "600" },
    );
  }
  // The robot joins this delegation's set in the claim's own transaction (the person owns it).
  const res = await claimRobot(env, createProvisioner(env), a.user.id, code, label, budget, a.d.delegation_id);
  if (!res.ok) {
    await finish(env, ev, outcomeOf(res.status));
    return failed(res.status, res.message);
  }
  await finish(env, ev, "ok", res.robotId);
  console.log("delegation: claimed", a.d.delegation_id, res.robotId);
  const r = await env.DB.prepare("SELECT hostname FROM robots WHERE robot_id = ?").bind(res.robotId).first<{ hostname: string | null }>();
  return json({ robotId: res.robotId, hostname: r?.hostname ?? null });
}
