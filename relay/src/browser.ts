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
  claimed: "Robot added. It connects within a few seconds; then press Open.",
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
  allow_teleop: number | null;
}

async function dashboard(env: Env, user: SessionUser, url: URL): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT r.robot_id, r.name, r.hostname, m.role, m.label, r.allow_teleop
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
${notice ? html`<p class="notice" role="status">${notice}</p>` : ""}
<div class="who"><h1>My robots</h1>
<form class="inline" method="post" action="/logout"><span class="muted">Signed in as <strong>${user.login}</strong></span> <button>Sign out</button></form></div>
${
  rows.results.length === 0
    ? html`<p class="muted">No robots yet. Start the Mowgli Connect agent on your robot and enter the pairing code it shows.</p>`
    : html`<ul class="robots">
${rows.results.map(
  (r) => html`<li class="robot">
<span class="name">${r.label ?? r.name ?? r.robot_id}</span>
<a class="btn primary open" href="/open/${r.robot_id}">Open</a>
<span class="meta">${
    r.hostname ? html`<span class="state">Tunnel ready</span>` : html`<span class="state wait">waiting for tunnel</span>`
  } · ${r.role === "owner" ? "Owner" : "Viewer"}${
    r.allow_teleop === null ? "" : html` · Remote joystick ${r.allow_teleop ? "on" : "off"}`
  }</span>
${
  r.role === "owner"
    ? html`<details><summary>Manage</summary><div class="manage">
<div><code>${r.robot_id}</code>${r.hostname ? html`<br><code>${r.hostname}</code>` : ""}</div>
<form method="post" action="/robots/${r.robot_id}/sessions/revoke"><button>Sign everyone out</button><p>Ends every open session on this robot, including yours.</p></form>
<p>Remote joystick is ${r.allow_teleop ? "allowed" : "off"} on this robot. Only the robot can change it: rerun the installer there.</p>
<form method="post" action="/robots/${r.robot_id}/unlink"><button class="danger">Unlink robot</button><p>Removes the robot from your account and deletes its tunnel. You will need a new pairing code to add it again.</p></form>
</div></details>`
    : ""
}
</li>`,
)}
</ul>`
}
<h2>Add a robot</h2>
<form class="panel" method="post" action="/claim">
<div class="fields">
<div><label for="code">Pairing code</label><input class="code" type="text" id="code" name="code" value="${code}" placeholder="sunny-tiger-moss" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" required maxlength="40" aria-describedby="code-hint"></div>
<div><label for="label">Name <span class="muted">(optional)</span></label><input type="text" id="label" name="label" placeholder="Front lawn" maxlength="64"></div>
<button class="primary">Add robot</button>
</div>
<p class="muted hint" id="code-hint">Three words, shown by the installer on your robot (or <code>docker logs mowgli-connect</code>). Spaces, dashes and capitals don't matter. Valid for 15 minutes.</p>
</form>
<script src="/pair.js"></script>`,
  );
}

function loggedOutPage(): Response {
  return page(
    "Sign in",
    html`<div class="hero"><h1>Open your mower from anywhere</h1>
<p>Sign in to see your robots and open their own web interface securely, without VPN or port forwarding.</p>
<p><a class="btn primary" href="/login">Sign in with GitHub</a></p>
<p class="muted">Access is invite-only while Mowgli Connect is a prototype.</p></div>`,
  );
}

function claimConfirm(code: string, robotId: string, name: string | null, error?: string, status = 200): Response {
  return page(
    "Claim robot",
    html`
${error ? html`<p class="error">${error}</p>` : ""}
<h1>Add this robot?</h1>
<p>${name ? html`The robot calls itself <strong>${name}</strong>.` : "The robot did not report a name."} <code>${robotId}</code></p>
<p class="muted">Only add a robot you control. You will become its owner.</p>
<form class="panel" method="post" action="/claim">
<input type="hidden" name="code" value="${code}">
<div class="fields"><div><label for="label">Name <span class="muted">(optional)</span></label><input type="text" id="label" name="label" placeholder="Front lawn" maxlength="64"></div><span></span>
<button class="primary">Add robot</button></div>
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
        html`<h1>Robot starting</h1><p>The robot is starting its tunnel. This usually takes a few seconds.</p><p><a class="btn primary" href="/open/${robotId}">Try again</a> <a class="btn" href="/">Back</a></p>`,
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
