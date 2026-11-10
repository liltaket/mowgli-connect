import type { Env } from "./env";
import { canOwn, isAdmin, ownedRobots, robotLimit } from "./access";
import { handleAdmin, isAdminPath } from "./admin";
import { appEnabled, handleAppBrowser, signOutDevice } from "./appApi";
import { claimRobot, limitMessage, planAddress, previewClaim, reachedLimit, unlinkRobot, type AddressPlan } from "./claim";
import { HOMEPAGE, html, lawn, markSvg, page, type PageUser, type SafeHtml } from "./html";
import { mintGrant, type Role } from "./grant";
import { finishLogin, startLogin } from "./oauth";
import { formatPairingCode, normalizePairingCode } from "./pairing";
import { createProvisioner } from "./provisioner";
import { handleShare, isSharePath, roleLabel } from "./share";
import {
  clearSessionCookie,
  destroySession,
  getSessionUser,
  originOk,
  SESSION_COOKIE,
  type SessionUser,
} from "./session";
import { latestAgentSha, updateAvailable } from "./updates";
import { cleanLabel, isRobotId, nowSeconds, parseCookies, readBodyText, safeReturnPath, sha256Hex } from "./util";

const NOTICES: Record<string, string> = {
  claimed: "Robot added. It is setting up its secure connection, which usually takes under a minute the first time. You can press Open now: it waits for the robot.",
  unlinked: "Robot unlinked.",
  revoked: "All sessions on that robot were signed out.",
  left: "You left that robot. It is no longer in your list.",
  device_signed_out:
    "The app on that device is signed out. Everyone was signed out of the robots you own (its robot sessions end within a few minutes), and you were signed out of Mowgli Connect in every other browser. Open your robots again from here.",
  // Signing a device out cannot sign everyone out of a robot someone else owns.
  device_signed_out_shared:
    "The app on that device is signed out, and you were signed out of Mowgli Connect in every other browser. Everyone was signed out of any robots you own. Robots shared with you are not covered: a session the app has open on one can last up to 12 hours. If the device is lost, ask each robot's owner to remove your share or to sign everyone out.",
};

const GITHUB_ICON = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

/** A robot added in the last 10 minutes that has never been seen online is still setting up. */
function settingUp(r: { first_online_at: number | null; claimed_at: number | null }): boolean {
  return r.first_online_at === null && nowSeconds() - (r.claimed_at ?? 0) < SETUP_WINDOW_SECONDS;
}

const SETUP_WINDOW_SECONDS = 10 * 60;

async function markFirstOnline(env: Env, robotId: string): Promise<void> {
  await env.DB.prepare("UPDATE robots SET first_online_at = ? WHERE robot_id = ? AND first_online_at IS NULL")
    .bind(nowSeconds(), robotId)
    .run();
}

function pageUser(env: Env, user: SessionUser): PageUser {
  return { login: user.login, name: user.name, admin: isAdmin(env, user.id) };
}

function redirect(location: string, status = 302, extra: HeadersInit = {}): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store", ...extra } });
}

function loginRedirect(url: URL): Response {
  return redirect(`/login?return_to=${encodeURIComponent(url.pathname + url.search)}`);
}

function forbiddenOrigin(): Response {
  return page("Forbidden", html`<h1>Request rejected</h1><p class="error">This request came from another site, so it was not carried out.</p><p><a href="/">Back to my robots</a></p>`, 403);
}

function notFound(): Response {
  return page("Not found", html`<div class="standby">${lawn(true)}<h1>Nothing growing here</h1><p class="muted">There is nothing at this address, or it belongs to a robot you do not have access to.</p><p class="actions"><a class="btn" href="/">Back to my robots</a></p></div>`, 404);
}

interface RobotListRow {
  robot_id: string;
  name: string | null;
  hostname: string | null;
  role: string;
  label: string | null;
  allow_teleop: number | null;
  tunnel_id: string | null;
  first_online_at: number | null;
  claimed_at: number | null;
  agent_version: string | null;
  owner_login: string | null;
  owner_label: string | null;
  shares: number;
}

async function dashboard(env: Env, user: SessionUser, url: URL): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT r.robot_id, r.name, r.hostname, m.role, m.label, r.allow_teleop, r.tunnel_id, r.first_online_at, r.claimed_at, r.agent_version,
            ou.login AS owner_login, o.label AS owner_label,
            (SELECT COUNT(*) FROM members s WHERE s.robot_id = r.robot_id AND s.role != 'owner') AS shares
     FROM members m JOIN robots r ON r.robot_id = m.robot_id
     LEFT JOIN members o ON o.robot_id = r.robot_id AND o.role = 'owner' LEFT JOIN users ou ON ou.id = o.user_id
     WHERE m.user_id = ? AND r.status = 'claimed' ORDER BY m.created_at`,
  )
    .bind(user.id)
    .all<RobotListRow>();
  const latest = await latestAgentSha(env);
  const prov = createProvisioner(env);
  const online = new Map<string, boolean | null>();
  await Promise.all(
    rows.results.slice(0, 20).map(async (r) => {
      if (!r.tunnel_id || !prov.connected) return;
      const up = await prov.connected(r.tunnel_id);
      online.set(r.robot_id, up);
      if (up && r.first_online_at === null) await markFirstOnline(env, r.robot_id);
    }),
  );
  const key = url.searchParams.get("notice") ?? "";
  const notice = Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
  const code = url.searchParams.get("code") ?? "";
  const limit = await robotLimit(env, user.id);
  const owned = await ownedRobots(env, user.id);
  const full = limit !== null && owned >= limit;
  const guest = !(await canOwn(env, user.id, user.login));
  const devicesSection = await devicesHtml(env, user, rows.results.some((r) => r.role !== "owner"));
  return page(
    "Robots",
    html`
${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
<div class="who"><h1>${guest ? "Robots shared with you" : "My robots"}</h1></div>
${
  rows.results.length === 0
    ? html`<div class="empty"><strong>No robots yet.</strong><span>Install the agent on your robot (<a href="${HOMEPAGE}#install">how</a>), then enter the pairing code it shows below.</span></div>`
    : html`<ul class="robots">
${rows.results.map(
  (r) => html`<li class="robot">
<span class="name">${r.label ?? (r.role === "owner" ? null : r.owner_label) ?? r.name ?? r.robot_id}</span>
<a class="btn primary open" href="/open/${r.robot_id}">Open</a>
<span class="meta">${
    !r.hostname
      ? html`<span class="state wait">waiting for tunnel</span>`
      : online.get(r.robot_id) === false
        ? settingUp(r)
          ? html`<span class="state wait">Setting up connection</span>`
          : html`<span class="state off">Offline</span>`
        : online.get(r.robot_id) === true
          ? html`<span class="state">Online</span>`
          : html`<span class="state">Tunnel ready</span>`
  }${
    r.role === "owner"
      ? html`<span>Owner${r.shares > 0 ? `, shared with ${r.shares}` : ""}</span>`
      : html`<span>Shared with you${r.owner_login ? ` by @${r.owner_login}` : ""}: ${roleLabel(r.role)}</span>`
  }${
    r.role !== "owner" || r.allow_teleop === null ? "" : html`<span>Remote joystick ${r.allow_teleop ? "on" : "off"}</span>`
  }${
    r.role === "owner" && updateAvailable(r.agent_version, latest) ? html`<span class="update">Update available</span>` : ""
  }</span>
${
  r.role === "owner"
    ? html`<details><summary>Manage</summary><div class="manage">
<div><code>${r.robot_id}</code>${r.hostname ? html`<code>${r.hostname}</code>` : ""}</div>
<div><a class="btn" href="/robots/${r.robot_id}/share">Share</a><p>${r.shares > 0 ? `Shared with ${r.shares} ${r.shares === 1 ? "person" : "people"}. ` : ""}Let someone else open this robot with their own GitHub account, view only or with control of mowing.</p></div>
<form method="post" action="/robots/${r.robot_id}/sessions/revoke"><button>Sign everyone out</button><p>Ends every open session on this robot, including yours.</p></form>
<p>Remote joystick is ${r.allow_teleop ? "allowed" : "off"} on this robot. Only the robot can change it: rerun the installer there.</p>
${
  updateAvailable(r.agent_version, latest)
    ? html`<div><p>A newer version of the agent is available. On the robot, run:</p><code class="cmdline">cd ~/mowgli-connect &amp;&amp; docker compose pull &amp;&amp; docker compose up -d</code><p>Or rerun the installer and turn on automatic updates.</p></div>`
    : ""
}
<form method="post" action="/robots/${r.robot_id}/unlink"><button class="danger">Unlink robot</button><p>Removes the robot from your account and deletes its tunnel. You will need a new pairing code to add it again.</p></form>
</div></details>`
    : html`<details><summary>Shared with you</summary><div class="manage">
<p>${r.role === "operator" ? "You can watch the robot and use its mowing controls: start, pause, stop, dock and emergency stop." : "You can watch the robot: its status, live map and schedules."} Only its owner can change its settings or share it.</p>
<form method="post" action="/robots/${r.robot_id}/leave"><button class="danger">Leave</button><p>Removes the robot from your list. Its owner can share it with you again.</p></form>
</div></details>`
}
</li>`,
)}
</ul>`
}
${
  guest
    ? html`<h2>Add a robot</h2><div class="empty"><strong>Your account can open robots shared with you.</strong><span>To add a robot of your own, ask the person who runs Mowgli Connect for an invitation.</span></div>`
    : html`<h2>Add a robot</h2>
${limit === null ? "" : html`<p class="quota">${owned} of ${limit} ${limit === 1 ? "robot" : "robots"} on your account.</p>`}
${
  full
    ? html`<div class="empty"><strong>Your account is full.</strong><span>Unlink a robot to add another, or ask the person who runs Mowgli Connect to raise your limit.</span></div>`
    : html`<form class="panel" method="post" action="/claim">
<input type="hidden" name="step" value="preview">
<div class="fields">
<div><label for="code">Pairing code</label><input class="code" type="text" id="code" name="code" value="${code}" placeholder="clover-hedgehog-dew" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" required maxlength="40" aria-describedby="code-hint"></div>
<div><label for="label">Name <span class="muted">(optional)</span></label><input type="text" id="label" name="label" placeholder="Front lawn" maxlength="64"></div>
<button class="primary">Continue</button>
</div>
<p class="muted hint" id="code-hint">Three words, shown by the installer on your robot (or <code>docker logs mowgli-connect</code>). Spaces, dashes and capitals do not matter. The code is valid for 15 minutes. You see the robot and its address before it is added.</p>
</form>
<script src="/pair.js"></script>`
}`
}
${devicesSection}`,
    200,
    {},
    pageUser(env, user),
  );
}

interface DeviceListRow {
  device_id: string;
  name: string;
  created_at: number;
  last_used_at: number;
}

/** The person's signed-in app devices, each with Sign out. Nothing when the app API is off. */
async function devicesHtml(env: Env, user: SessionUser, shared: boolean): Promise<SafeHtml | string> {
  if (!appEnabled(env)) return "";
  const rows = await env.DB.prepare("SELECT device_id, name, created_at, last_used_at FROM devices WHERE user_id = ? ORDER BY created_at")
    .bind(user.id)
    .all<DeviceListRow>();
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  return html`<h2>Devices</h2>
${
  rows.results.length === 0
    ? html`<p class="muted">The Mowgli app is not signed in on any device.</p>`
    : html`<ul class="people">${rows.results.map(
        (d) => html`<li class="person"><span class="avatar" aria-hidden="true">${d.name.charAt(0).toUpperCase()}</span>
<div class="person-main"><span class="person-name">${d.name}</span><span class="meta"><span>Signed in ${day(d.created_at)}</span><span>Last used ${day(d.last_used_at)}</span></span></div>
<form class="orphan-unlink" method="post" action="/devices/${d.device_id}/revoke"><button class="danger">Sign out this device</button><p class="muted">Also signs everyone out of the robots you own, so a lost phone loses its open robot sessions too.${shared ? " Not of robots shared with you: their owner can remove your share or sign everyone out." : ""}</p></form></li>`,
      )}</ul>`
}`;
}

function claimError(env: Env, user: SessionUser, message: string, status: number, code?: string): Response {
  const norm = code ? normalizePairingCode(code) : null;
  return page(
    "Add a robot",
    html`<h1>Could not add the robot</h1><p class="error">${message}</p><p><a href="/${norm ? `?code=${formatPairingCode(norm)}` : ""}">Back to my robots</a></p>`,
    status,
    {},
    pageUser(env, user),
  );
}

function loggedOutPage(url: URL): Response {
  const notice = url.searchParams.get("notice");
  return page(
    "Sign in",
    html`${notice === "signedout" ? html`<p class="notice" role="status">You are signed out of Mowgli Connect. A robot you opened stays signed in in this browser for up to 12 hours. To end that now, sign in and use Sign everyone out under the robot's Manage.</p>` : ""}
${notice === "left_last" ? html`<p class="notice" role="status">You left the last robot shared with you, so you are signed out of Mowgli Connect.</p>` : ""}
<div class="landing"><div>${markSvg("big-mark")}</div>
<div><h1>Your mower's own app, from anywhere</h1>
<p class="lead">Sign in to see your robots and open their own web interface, without VPN or port forwarding.</p>
<p class="actions"><a class="btn primary gh" href="/login">${GITHUB_ICON}Sign in with GitHub</a></p>
<ul class="facts">
<li>GitHub shares your public profile only. Mowgli Connect keeps your user id, username and name, and gets no access to your repositories.</li>
<li>Access is invite-only while Mowgli Connect is a prototype. Someone who shares a robot with you lets you in to open it.</li>
<li>New here? <a href="${HOMEPAGE}">See how it works</a>, or <a href="${HOMEPAGE}#install">install it on your robot</a>.</li>
</ul></div></div>`,
    200,
    {},
    null,
  );
}

function addressNote(plan: AddressPlan, robotId: string): string {
  if (plan.taken) {
    return plan.hostname.startsWith(`${robotId}.`)
      ? `${plan.taken} and the names after it are taken, so it gets its id as its address. Choose another name to get a readable one.`
      : `${plan.taken} is taken by another robot, so it gets the next free name.`;
  }
  return plan.hostname.startsWith(`${robotId}.`) ? "Give it a name of at least 3 letters or digits to get a readable address." : "You open the robot at this address. It stays the same until you unlink the robot.";
}

async function claimConfirm(
  env: Env,
  user: SessionUser,
  code: string,
  robotId: string,
  robotName: string | null,
  label: string | null,
  changed = false,
): Promise<Response> {
  const plan = await planAddress(env, createProvisioner(env), robotId, label ?? robotName);
  const limit = await robotLimit(env, user.id);
  const owned = await ownedRobots(env, user.id);
  return page(
    "Add a robot",
    html`
${changed ? html`<p class="notice" role="status">The name changed, so the address may have too. Check it and press Add robot again.</p>` : ""}
<h1>Add this robot?</h1>
<p>${robotName ? html`The robot calls itself <strong>${robotName}</strong>.` : "The robot did not report a name."} Its id is <code>${robotId}</code>.</p>
${plan ? html`<div class="address"><span>Its address will be</span><strong>${plan.hostname}</strong><span>${addressNote(plan, robotId)}</span></div>` : ""}
<form class="panel" method="post" action="/claim">
<input type="hidden" name="code" value="${code}">
<input type="hidden" name="step" value="confirm">
<input type="hidden" name="shown_label" value="${label ?? ""}">
<div class="fields fields-2"><div><label for="label">Name <span class="muted">(optional)</span></label><input type="text" id="label" name="label" value="${label ?? ""}" placeholder="Front lawn" maxlength="64" aria-describedby="label-hint"></div>
<button class="primary">Add robot</button></div>
<p class="muted hint" id="label-hint">Shown in your list${plan ? " and used for the address" : ""}. Empty uses the robot's own name.${plan ? " If you change it, you see the new address before the robot is added." : ""}</p>
</form>
<p class="muted">Only add a robot you control. You become its owner.${limit === null ? "" : ` It will be robot ${owned + 1} of ${limit} on your account.`}</p>
<p><a href="/">Cancel</a></p>`,
    200,
    {},
    pageUser(env, user),
  );
}

interface ClaimForm {
  code: string;
  label: string | null;
  step: string | null;
  shownLabel: string | null;
}

async function readForm(request: Request): Promise<ClaimForm | null> {
  const text = await readBodyText(request, 4096);
  if (text === null) return null;
  const ct = request.headers.get("Content-Type") ?? "";
  let code: unknown;
  let label: unknown;
  let step: unknown;
  let shown: unknown;
  try {
    if (ct.startsWith("application/json")) {
      const j = JSON.parse(text) as Record<string, unknown>;
      code = j.code;
      label = j.label;
    } else {
      const p = new URLSearchParams(text);
      code = p.get("code");
      label = p.get("label");
      step = p.get("step");
      shown = p.get("shown_label");
    }
  } catch {
    return null;
  }
  if (typeof code !== "string") return null;
  return {
    code: code.slice(0, 64),
    label: cleanLabel(label),
    step: typeof step === "string" ? step : null,
    shownLabel: typeof shown === "string" ? cleanLabel(shown) : null,
  };
}

export async function handleBrowser(request: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;
  const isWrite = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  const known =
    pathname === "/" ||
    pathname === "/login" ||
    pathname === "/auth/github/callback" ||
    pathname === "/logout" ||
    pathname === "/claim" ||
    /^\/open\/[^/]+$/.test(pathname) ||
    /^\/robots\/[^/]+\/(unlink|sessions\/revoke)$/.test(pathname) ||
    isSharePath(pathname) ||
    isAdminPath(pathname) ||
    pathname === "/app/authorize" ||
    pathname === "/app/callback" ||
    /^\/devices\/[^/]+\/revoke$/.test(pathname);
  if (!known) return null;

  // CSRF: every state-changing browser request must carry our own Origin.
  if (isWrite && !originOk(request, env)) return forbiddenOrigin();

  if (pathname === "/login" && method === "GET") {
    const user = await getSessionUser(env, request);
    const rt = safeReturnPath(url.searchParams.get("return_to"));
    return user ? redirect(rt) : startLogin(env, rt);
  }
  if (pathname === "/auth/github/callback" && method === "GET") return finishLogin(env, url, request);

  const user = await getSessionUser(env, request);

  if (pathname === "/" && method === "GET") return user ? dashboard(env, user, url) : loggedOutPage(url);

  if (isAdminPath(pathname)) return handleAdmin(request, env, url, user, notFound);

  if (pathname === "/app/authorize" || pathname === "/app/callback") {
    return (await handleAppBrowser(request, env, url, user, (u) => pageUser(env, u), loginRedirect)) ?? notFound();
  }

  const dev = /^\/devices\/([^/]+)\/revoke$/.exec(pathname);
  if (dev && method === "POST") {
    if (!user) return redirect("/login", 303);
    // Also ends the robot sessions the app still had (robots this person owns), pending app
    // sign-ins, and the person's relay sessions in every other browser (a lost phone's included).
    // Not on robots shared with them: the notice says so when there are any.
    const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
    const keep = token ? await sha256Hex(token) : null;
    if (!(await signOutDevice(env, dev[1]!, user.id, { lostDevice: { keepSessionHash: keep } }))) return notFound();
    const shared = await env.DB.prepare(
      "SELECT 1 AS ok FROM members m JOIN robots r ON r.robot_id = m.robot_id WHERE m.user_id = ? AND m.role != 'owner' AND r.status = 'claimed' LIMIT 1",
    )
      .bind(user.id)
      .first();
    return redirect(shared ? "/?notice=device_signed_out_shared" : "/?notice=device_signed_out", 303);
  }

  if (pathname === "/logout" && method === "POST") {
    await destroySession(env, request);
    return redirect("/?notice=signedout", 303, { "Set-Cookie": clearSessionCookie() });
  }

  if (pathname === "/claim") {
    if (method === "GET") {
      if (!user) return loginRedirect(url);
      const raw = url.searchParams.get("code") ?? "";
      // A code link counts against the guess budget only when the owner opens it (typed, pasted
      // or clicked from here). A page on a sibling *.bronc.app host loading it in the background
      // must not use the budget up; it gets the form, filled in, instead.
      const site = request.headers.get("Sec-Fetch-Site");
      if (site && site !== "none" && site !== "same-origin") {
        const norm = normalizePairingCode(raw);
        return redirect(norm ? `/?code=${formatPairingCode(norm)}` : "/");
      }
      // The limit first: someone who cannot add a robot (a guest) gets no pairing-code lookups.
      const full = await reachedLimit(env, user.id);
      if (full !== null) return claimError(env, user, limitMessage(full), 403);
      const prev = await previewClaim(env, user.id, raw);
      if (!prev.ok) return claimError(env, user, prev.message, prev.status);
      return claimConfirm(env, user, normalizePairingCode(raw) ?? "", prev.robotId, prev.name, null);
    }
    if (method === "POST") {
      if (!user) return redirect("/login", 303);
      const form = await readForm(request);
      if (!form) return claimError(env, user, "The form was not filled in correctly.", 400);
      // Step 1 (or a changed name in step 2): show the robot and the address it would get.
      if (form.step === "preview" || (form.step === "confirm" && form.shownLabel !== form.label)) {
        const full = await reachedLimit(env, user.id);
        if (full !== null) return claimError(env, user, limitMessage(full), 403);
        const prev = await previewClaim(env, user.id, form.code);
        if (!prev.ok) return claimError(env, user, prev.message, prev.status, form.code);
        return claimConfirm(env, user, normalizePairingCode(form.code) ?? "", prev.robotId, prev.name, form.label, form.step === "confirm");
      }
      const res = await claimRobot(env, createProvisioner(env), user.id, form.code, form.label);
      if (!res.ok) return claimError(env, user, res.message, res.status, form.code);
      return redirect("/?notice=claimed", 303);
    }
    return null;
  }

  const open = /^\/open\/([^/]+)$/.exec(pathname);
  if (open && method === "GET") {
    if (!user) return loginRedirect(url);
    const robotId = open[1]!;
    if (!isRobotId(robotId)) return notFound();
    // Non-members and unknown robots get the same 404.
    const row = await env.DB.prepare(
      `SELECT r.hostname, r.session_epoch, r.tunnel_id, r.claimed_at, r.first_online_at, m.role
       FROM members m JOIN robots r ON r.robot_id = m.robot_id
       WHERE m.robot_id = ? AND m.user_id = ? AND r.status = 'claimed'`,
    )
      .bind(robotId, user.id)
      .first<{
        hostname: string | null;
        session_epoch: number;
        tunnel_id: string | null;
        claimed_at: number | null;
        first_online_at: number | null;
        role: Role;
      }>();
    if (!row) return notFound();
    // Only send the browser to the robot once its tunnel is up: otherwise it would get a
    // Cloudflare error page, or (for a robot added seconds ago) look up a name that is still
    // propagating and cache "not found" for up to 30 minutes.
    const prov = createProvisioner(env);
    const up = row.tunnel_id && prov.connected ? await prov.connected(row.tunnel_id) : null;
    if (up && row.first_online_at === null) await markFirstOnline(env, robotId);
    if (up === false) {
      const firstTime = row.first_online_at === null;
      const setup = settingUp(row);
      const retry = html`<p class="actions"><a class="btn primary" href="/open/${robotId}">Try now</a> <a class="btn" href="/">Back to my robots</a></p>`;
      const help = html`<p class="muted">Check that the robot is switched on and has internet. On the robot, <code>docker logs mowgli-connect</code> shows what the agent is doing.</p>`;
      return page(
        setup ? "Setting up" : "Robot offline",
        setup
          ? html`<div class="standby">${lawn()}<h1>Setting up your robot's connection…</h1>
<p>This is normal right after adding a robot: it is creating its secure connection to Cloudflare, which usually takes under a minute. This page opens the robot by itself as soon as it is ready.</p>
${retry}</div>`
          : firstTime
            ? html`<div class="standby">${lawn()}<h1>Still waiting for your robot</h1>
<p>The robot has not connected since it was added. This page keeps trying.</p>
${help}${retry}</div>`
            : html`<div class="standby">${lawn(true)}<h1>Your robot is offline</h1>
<p>It is not connected right now, for example because it is switched off or out of Wi-Fi range. This page opens it by itself when it is back.</p>
${help}${retry}</div>`,
        503,
        { "Retry-After": "5", Refresh: "5" },
        pageUser(env, user),
      );
    }
    if (!row.hostname) {
      // Quick-tunnel mode: claimed, but the robot has not reported its tunnel hostname yet.
      return page(
        "Robot starting",
        html`<div class="standby">${lawn()}<h1>Robot starting</h1><p>The robot is starting its tunnel. This usually takes a few seconds.</p><p class="actions"><a class="btn primary" href="/open/${robotId}">Try again</a> <a class="btn" href="/">Back to my robots</a></p></div>`,
        503,
        { "Retry-After": "10" },
        pageUser(env, user),
      );
    }
    const grant = await mintGrant(env, {
      robotId,
      userId: user.id,
      name: user.name ?? user.login,
      role: row.role,
      epoch: row.session_epoch,
    });
    return redirect(`https://${row.hostname}/_connect/callback#grant=${grant}`, 302);
  }

  if (isSharePath(pathname)) return handleShare(request, env, url, user, (u) => pageUser(env, u), loginRedirect, notFound);

  const act = /^\/robots\/([^/]+)\/(unlink|sessions\/revoke)$/.exec(pathname);
  if (act && method === "POST") {
    if (!user) return redirect("/login", 303);
    const robotId = act[1]!;
    if (!isRobotId(robotId)) return notFound();
    const owner = await env.DB.prepare("SELECT 1 AS ok FROM members WHERE robot_id = ? AND user_id = ? AND role = 'owner'")
      .bind(robotId, user.id)
      .first();
    if (!owner) return notFound();
    if (act[2] === "unlink") {
      const ok = await unlinkRobot(env, createProvisioner(env), robotId);
      return ok ? redirect("/?notice=unlinked", 303) : notFound();
    }
    const res = await env.DB.prepare(
      "UPDATE robots SET session_epoch = session_epoch + 1, updated_at = ? WHERE robot_id = ? AND status = 'claimed'",
    )
      .bind(nowSeconds(), robotId)
      .run();
    return res.meta.changes === 1 ? redirect("/?notice=revoked", 303) : notFound();
  }

  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
}
