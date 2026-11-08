import type { Env } from "./env";
import { claimRobot, previewClaim, unlinkRobot } from "./claim";
import { html, page } from "./html";
import { mintGrant } from "./grant";
import { finishLogin, startLogin } from "./oauth";
import { formatPairingCode, normalizePairingCode } from "./pairing";
import { createProvisioner } from "./provisioner";
import {
  clearSessionCookie,
  destroySession,
  getSessionUser,
  originOk,
  type SessionUser,
} from "./session";
import { cleanLabel, isRobotId, nowSeconds, readBodyText, safeReturnPath } from "./util";

const NOTICES: Record<string, string> = {
  claimed: "Robot claimed.",
  unlinked: "Robot unlinked.",
  revoked: "All sessions on that robot were signed out.",
};

function redirect(location: string, status = 302, extra: HeadersInit = {}): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store", ...extra } });
}

function loginRedirect(url: URL): Response {
  return redirect(`/login?return_to=${encodeURIComponent(url.pathname + url.search)}`);
}

function forbiddenOrigin(): Response {
  return page("Forbidden", html`<p class="error">Cross-origin request rejected.</p>`, 403);
}

function notFound(): Response {
  return page("Not found", html`<p>Not found.</p><p><a href="/">Home</a></p>`, 404);
}

interface RobotListRow {
  robot_id: string;
  name: string | null;
  hostname: string | null;
  role: string;
  label: string | null;
}

async function dashboard(env: Env, user: SessionUser, url: URL): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT r.robot_id, r.name, r.hostname, m.role, m.label
     FROM members m JOIN robots r ON r.robot_id = m.robot_id
     WHERE m.user_id = ? AND r.status = 'claimed' ORDER BY m.created_at`,
  )
    .bind(user.id)
    .all<RobotListRow>();
  const notice = NOTICES[url.searchParams.get("notice") ?? ""];
  const code = url.searchParams.get("code") ?? "";
  return page(
    "Robots",
    html`
${notice ? html`<p class="notice">${notice}</p>` : ""}
<div class="row"><span>Signed in as <strong>${user.login}</strong></span>
<form class="inline" method="post" action="/logout"><button>Sign out</button></form></div>
<h2>My robots</h2>
${
  rows.results.length === 0
    ? html`<p class="muted">No robots yet. Enter the pairing code shown by your robot below.</p>`
    : html`<table>
<tr><th>Robot</th><th>Hostname</th><th>Role</th><th></th></tr>
${rows.results.map(
  (r) => html`<tr>
<td>${r.label ?? r.name ?? r.robot_id}<br><code>${r.robot_id}</code></td>
<td>${r.hostname ? html`<code>${r.hostname}</code>` : html`<span class="muted">waiting for tunnel</span>`}</td>
<td>${r.role}</td>
<td class="actions">
<a class="btn primary" href="/open/${r.robot_id}">Open</a>
${
  r.role === "owner"
    ? html`<form class="inline" method="post" action="/robots/${r.robot_id}/sessions/revoke"><button>Sign everyone out</button></form>
<form class="inline" method="post" action="/robots/${r.robot_id}/unlink"><button class="danger">Unlink</button></form>`
    : ""
}
</td></tr>`,
)}
</table>`
}
<h2>Claim a robot</h2>
<form method="post" action="/claim">
<div class="row"><input type="text" name="code" value="${code}" placeholder="XXXX-XXXX-XX" autocomplete="off" required maxlength="32">
<input type="text" name="label" placeholder="Label (optional)" maxlength="64">
<button class="primary">Claim</button></div>
</form>`,
  );
}

function loggedOutPage(): Response {
  return page(
    "Sign in",
    html`<p>Sign in to manage and open your robots.</p><p><a class="btn primary" href="/login">Sign in with GitHub</a></p>`,
  );
}

function claimConfirm(code: string, robotId: string, name: string | null, error?: string, status = 200): Response {
  return page(
    "Claim robot",
    html`
${error ? html`<p class="error">${error}</p>` : ""}
<h2>Claim this robot?</h2>
<p>Robot <code>${robotId}</code>${name ? html` (reported name: <em>${name}</em>)` : ""}</p>
<p class="muted">Only claim a robot you control. You will become its owner.</p>
<form method="post" action="/claim">
<input type="hidden" name="code" value="${code}">
<div class="row"><input type="text" name="label" placeholder="Label (optional)" maxlength="64"><button class="primary">Claim robot</button></div>
</form>
<p><a href="/">Cancel</a></p>`,
    status,
  );
}

async function readForm(request: Request): Promise<{ code: string; label: string | null } | null> {
  const text = await readBodyText(request, 4096);
  if (text === null) return null;
  const ct = request.headers.get("Content-Type") ?? "";
  let code: unknown;
  let label: unknown;
  try {
    if (ct.startsWith("application/json")) {
      const j = JSON.parse(text) as Record<string, unknown>;
      code = j.code;
      label = j.label;
    } else {
      const p = new URLSearchParams(text);
      code = p.get("code");
      label = p.get("label");
    }
  } catch {
    return null;
  }
  if (typeof code !== "string") return null;
  return { code: code.slice(0, 64), label: cleanLabel(label) };
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
    /^\/robots\/[^/]+\/(unlink|sessions\/revoke)$/.test(pathname);
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

  if (pathname === "/" && method === "GET") return user ? dashboard(env, user, url) : loggedOutPage();

  if (pathname === "/logout" && method === "POST") {
    await destroySession(env, request);
    return redirect("/", 303, { "Set-Cookie": clearSessionCookie() });
  }

  if (pathname === "/claim") {
    if (method === "GET") {
      if (!user) return loginRedirect(url);
      const raw = url.searchParams.get("code") ?? "";
      const prev = await previewClaim(env, user.id, raw);
      if (!prev.ok) return page("Claim robot", html`<p class="error">${prev.message}</p><p><a href="/">Back</a></p>`, prev.status);
      return claimConfirm(normalizePairingCode(raw) ?? "", prev.robotId, prev.name);
    }
    if (method === "POST") {
      if (!user) return redirect("/login", 303);
      const form = await readForm(request);
      if (!form) return page("Claim robot", html`<p class="error">Bad request.</p>`, 400);
      const res = await claimRobot(env, createProvisioner(env), user.id, form.code, form.label);
      if (!res.ok) {
        const norm = normalizePairingCode(form.code);
        return page(
          "Claim robot",
          html`<p class="error">${res.message}</p><p><a href="/${norm ? `?code=${formatPairingCode(norm)}` : ""}">Back</a></p>`,
          res.status,
        );
      }
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
      `SELECT r.hostname, r.session_epoch, m.role FROM members m JOIN robots r ON r.robot_id = m.robot_id
       WHERE m.robot_id = ? AND m.user_id = ? AND r.status = 'claimed'`,
    )
      .bind(robotId, user.id)
      .first<{ hostname: string | null; session_epoch: number; role: "owner" | "viewer" }>();
    if (!row) return notFound();
    if (!row.hostname) {
      // Quick-tunnel mode: claimed, but the robot has not reported its tunnel hostname yet.
      return page(
        "Robot starting",
        html`<p>The robot is starting its tunnel. Retry in a moment.</p><p><a class="btn primary" href="/open/${robotId}">Retry</a> <a href="/">Back</a></p>`,
        503,
        { "Retry-After": "10" },
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
