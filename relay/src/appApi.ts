import { isUserAllowed, ownedRobots, robotLimit } from "./access";
import { claimRobot, planAddress, previewClaim, reachedLimit, limitMessage } from "./claim";
import { DEVICE_ID, DeviceAuthError, jwkThumbprint, parseDeviceJwk, verifyDeviceAssertion, type DeviceJwk } from "./deviceAuth";
import type { Env } from "./env";
import { mintGrant } from "./grant";
import { html, page, type PageUser } from "./html";
import { createProvisioner } from "./provisioner";
import { json } from "./robotApi";
import type { SessionUser } from "./session";
import { latestAgentSha, updateAvailable } from "./updates";
import { cleanLabel, isRobotId, nowSeconds, randomToken, readBodyText, sha256Hex, SKEW_SECONDS } from "./util";

/**
 * The native app API (docs/app-api.md): sign-in with consent in a browser sheet, a one-time code
 * exchanged for a device (a Secure Enclave P-256 key), and signed calls to list robots and get
 * grants. Off unless APP_IOS_APP_IDS names the app(s) allowed to receive sign-ins.
 */

export const MAX_DEVICES_PER_USER = 10;
const MAX_OPEN_CODES = 5;
const CODE_TTL_SECONDS = 60;
const LAST_USED_REFRESH_SECONDS = 15 * 60;
/** A device unused this long is signed out (the cron deletes it; calls refuse it before that). */
export const DEVICE_IDLE_SECONDS = 180 * 86400;

const APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/; // <TeamID>.<bundle id>
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9._~-]{16,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;

export function appIds(env: Env): string[] {
  return (env.APP_IOS_APP_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => APP_ID.test(s));
}

export function appEnabled(env: Env): boolean {
  return appIds(env).length > 0;
}

function callbackUrl(env: Env): string {
  return `${env.RELAY_ORIGIN}/app/callback`;
}

/**
 * Private-use URI scheme callbacks (RFC 8252 7.1), for apps that cannot use associated domains
 * (a free Apple Personal Team). Only `<bundle id>:/<path>` for a bundle id in APP_IOS_APP_IDS is
 * accepted, so the scheme is always the reverse-DNS name of the configured app. Weaker than the
 * HTTPS callback: the relay cannot know that this app, and not another one claiming the same
 * scheme in its own authentication session, receives the code (docs/app-api.md).
 */
export function schemeRedirects(env: Env): string[] {
  const bundles = new Set(appIds(env).map((id) => id.slice(id.indexOf(".") + 1).toLowerCase()));
  return (env.APP_REDIRECT_URIS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((u) => {
      const m = /^([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+):\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.exec(u);
      return m !== null && bundles.has(m[1]!);
    });
}

function allowedRedirect(env: Env, uri: string | null): uri is string {
  return uri !== null && (uri === callbackUrl(env) || schemeRedirects(env).includes(uri));
}

/** apple-app-site-association: only the configured apps, only the callback path. */
export function appleAppSiteAssociation(env: Env): Response {
  const apps = appIds(env);
  if (apps.length === 0) return new Response("Not found", { status: 404 });
  return new Response(
    JSON.stringify({
      applinks: { details: [{ appIDs: apps, components: [{ "/": "/app/callback", comment: "Mowgli Connect sign-in" }] }] },
      webcredentials: { apps },
    }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } },
  );
}

async function b64urlSha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface AuthorizeParams {
  redirectUri: string;
  challenge: string;
  state: string;
  thumbprint: string;
  deviceName: string;
}

function readAuthorizeParams(env: Env, get: (k: string) => string | null): AuthorizeParams | null {
  const redirectUri = get("redirect_uri");
  const challenge = get("code_challenge");
  const method = get("code_challenge_method");
  const state = get("state");
  const thumbprint = get("key_thumbprint");
  const deviceName = cleanLabel(get("device_name"), 40);
  if (!allowedRedirect(env, redirectUri) || method !== "S256") return null;
  if (!challenge || !CHALLENGE.test(challenge) || !state || !STATE.test(state)) return null;
  if (!thumbprint || !DEVICE_ID.test(thumbprint) || !deviceName) return null;
  return { redirectUri, challenge, state, thumbprint, deviceName };
}

/** The consent form redirects to the app's scheme after the POST: CSP form-action must allow it. */
function withFormTarget(p: AuthorizeParams, res: Response): Response {
  const scheme = new URL(p.redirectUri).protocol; // "garden.mowgli.prototypes:" or "https:"
  if (scheme !== "https:") {
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    res.headers.set("Content-Security-Policy", csp.replace("form-action 'self'", `form-action 'self' ${scheme}`));
  }
  return res;
}

function back(p: AuthorizeParams, q: Record<string, string>): Response {
  const u = new URL(p.redirectUri);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  u.searchParams.set("state", p.state);
  return new Response(null, { status: 303, headers: { Location: u.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

function appPage(title: string, body: ReturnType<typeof html>, status: number, user?: PageUser | null): Response {
  return page(title, body, status, {}, user);
}

async function deviceCount(env: Env, userId: string, except?: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND device_id != ?")
    .bind(userId, except ?? "")
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * GET/POST /app/authorize and GET /app/callback, inside the browser sheet. The caller has
 * already checked the Origin of a POST (browser.ts) and loaded the session user.
 */
export async function handleAppBrowser(
  request: Request,
  env: Env,
  url: URL,
  user: SessionUser | null,
  pageUser: (u: SessionUser) => PageUser,
  loginRedirect: (u: URL) => Response,
): Promise<Response | null> {
  if (!appEnabled(env)) return null;
  if (url.pathname === "/app/callback" && request.method === "GET") {
    // Normally the app receives this URL before it loads. If a browser does load it, show nothing
    // of the code and send no Referer anywhere.
    const res = appPage(
      "Return to the app",
      html`<div class="standby"><h1>Return to the Mowgli app</h1><p class="muted">Sign-in finished. If the app did not open by itself, switch back to it and start the sign-in again there.</p>
<p class="error">Never copy or send the address of this page to anyone. It works as a one-time key to your account.</p></div>`,
      200,
    );
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  }
  if (url.pathname !== "/app/authorize") return null;

  if (request.method === "GET") {
    const p = readAuthorizeParams(env, (k) => url.searchParams.get(k));
    if (!p) return appPage("Sign-in failed", html`<h1>This sign-in link is not valid</h1><p class="muted">Start the sign-in again from the app.</p>`, 400);
    if (!user) return loginRedirect(url);
    if ((await deviceCount(env, user.id, p.thumbprint)) >= MAX_DEVICES_PER_USER) {
      return appPage(
        "Too many devices",
        html`<h1>Too many devices</h1><p>Your account is signed in on ${MAX_DEVICES_PER_USER} devices already. Sign one out under Devices on <a href="/">your robots page</a>, then try again.</p>`,
        403,
        pageUser(user),
      );
    }
    const hidden = (k: string, v: string) => html`<input type="hidden" name="${k}" value="${v}">`;
    return withFormTarget(p, appPage(
      "Sign in to the app",
      html`<h1>Sign in to the Mowgli app?</h1>
<div class="panel invitee"><span class="avatar big" aria-hidden="true">${(user.name ?? user.login).charAt(0).toUpperCase()}</span>
<div><strong>${p.deviceName}</strong><span class="muted">signs in as @${user.login}</span></div></div>
<p>The app on this device will see your robots and can open them as you, from anywhere. You can sign it out at any time under Devices on your robots page.</p>
<p class="muted">Only continue if you started this sign-in yourself, a moment ago, in the Mowgli app on your own phone. If you got here from a link someone sent you, press Cancel.</p>
<form method="post" action="/app/authorize">
${hidden("redirect_uri", p.redirectUri)}${hidden("code_challenge", p.challenge)}${hidden("code_challenge_method", "S256")}${hidden("state", p.state)}${hidden("key_thumbprint", p.thumbprint)}${hidden("device_name", p.deviceName)}
<p class="actions"><button class="primary" name="decision" value="allow">Sign in</button> <button name="decision" value="deny">Cancel</button></p>
</form>`,
      200,
      pageUser(user),
    ));
  }

  if (request.method === "POST") {
    if (!user) return new Response(null, { status: 303, headers: { Location: "/login", "Cache-Control": "no-store" } });
    const ct = request.headers.get("Content-Type") ?? "";
    const text = ct.startsWith("application/x-www-form-urlencoded") ? await readBodyText(request, 4096) : null;
    const form = text === null ? null : new URLSearchParams(text);
    const p = form ? readAuthorizeParams(env, (k) => form.get(k)) : null;
    if (!form || !p) return appPage("Sign-in failed", html`<h1>This sign-in is not valid</h1><p class="muted">Start the sign-in again from the app.</p>`, 400);
    if (form.get("decision") !== "allow") return back(p, { error: "access_denied" });
    if ((await deviceCount(env, user.id, p.thumbprint)) >= MAX_DEVICES_PER_USER) return back(p, { error: "too_many_devices" });
    const code = randomToken(32);
    const now = nowSeconds();
    // At most MAX_OPEN_CODES unexpired codes per person, in the same statement as the insert.
    const ins = await env.DB.prepare(
      `INSERT INTO app_codes (code_hash, user_id, code_challenge, key_thumbprint, device_name, expires_at, redirect_uri)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?9
       WHERE (SELECT COUNT(*) FROM app_codes WHERE user_id = ?2 AND expires_at > ?7) < ?8`,
    )
      .bind(await sha256Hex(`mc-app-code:${code}`), user.id, p.challenge, p.thumbprint, p.deviceName, now + CODE_TTL_SECONDS, now, MAX_OPEN_CODES, p.redirectUri)
      .run();
    if (ins.meta.changes !== 1) return back(p, { error: "slow_down" });
    return back(p, { code });
  }
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return null;
  const text = await readBodyText(request, 4096);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function authFailure(e: DeviceAuthError): Response {
  return json({ error: "invalid_assertion", detail: e.code }, 401);
}

async function consumeJti(env: Env, deviceId: string, jti: string, exp: number): Promise<boolean> {
  const res = await env.DB.prepare("INSERT OR IGNORE INTO jti_seen (robot_id, jti, expires_at) VALUES (?, ?, ?)")
    .bind(`dev:${deviceId}`, jti, exp + SKEW_SECONDS)
    .run();
  return res.meta.changes === 1;
}

/** POST /v1/app/token: one-time code + PKCE verifier + proof of the device key -> a device. */
async function token(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json({ error: "bad_request" }, 400);
  const jwk = parseDeviceJwk(body.device_key);
  const code = body.code;
  const verifier = body.code_verifier;
  if (!jwk || typeof code !== "string" || !CODE.test(code) || typeof verifier !== "string" || !VERIFIER.test(verifier) || typeof body.redirect_uri !== "string" || !allowedRedirect(env, body.redirect_uri)) {
    return json({ error: "bad_request" }, 400);
  }
  const thumbprint = await jwkThumbprint(jwk);
  let a;
  try {
    // Proof of possession: the call is signed by the key it registers.
    a = await verifyDeviceAssertion({
      authorization: request.headers.get("Authorization"),
      method: request.method,
      htu: `${env.RELAY_ORIGIN}${url.pathname}`,
      aud: env.RELAY_ORIGIN,
      now: nowSeconds(),
      resolveKey: async (iss) => (iss === thumbprint ? jwk : null),
    });
  } catch (e) {
    if (e instanceof DeviceAuthError) return authFailure(e);
    throw e;
  }
  const now = nowSeconds();
  // The code is used up only together with its verifier and its key, in one statement: a wrong or
  // made-up code writes nothing, and someone who saw a code cannot spoil the real sign-in with it.
  const row = await env.DB.prepare(
    `DELETE FROM app_codes WHERE code_hash = ? AND expires_at > ? AND code_challenge = ? AND key_thumbprint = ? AND redirect_uri = ?
     RETURNING user_id, device_name`,
  )
    .bind(await sha256Hex(`mc-app-code:${code}`), now, await b64urlSha256(verifier), thumbprint, body.redirect_uri)
    .first<{ user_id: string; device_name: string }>();
  if (!row) return json({ error: "invalid_grant" }, 400);
  if (!(await consumeJti(env, thumbprint, a.jti, a.exp))) return authFailure(new DeviceAuthError("replayed_jti"));
  const user = await env.DB.prepare("SELECT id, login, name FROM users WHERE id = ?").bind(row.user_id).first<SessionUser>();
  if (!user || !(await isUserAllowed(env, user.id, user.login))) return json({ error: "no_access" }, 403);
  // One statement: the device limit and "a key belongs to one person" hold under concurrency.
  const saved = await env.DB.prepare(
    `INSERT INTO devices (device_id, user_id, name, public_jwk, created_at, last_used_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?5
     WHERE (SELECT COUNT(*) FROM devices WHERE user_id = ?2 AND device_id != ?1) < ?6
     ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, last_used_at = excluded.last_used_at WHERE devices.user_id = ?2`,
  )
    .bind(thumbprint, user.id, row.device_name, JSON.stringify(jwk), now, MAX_DEVICES_PER_USER)
    .run();
  if (saved.meta.changes !== 1) {
    const owner = await env.DB.prepare("SELECT user_id FROM devices WHERE device_id = ?").bind(thumbprint).first<{ user_id: string }>();
    return owner && owner.user_id !== user.id
      ? json({ error: "device_belongs_to_another_account" }, 409)
      : json({ error: "too_many_devices" }, 403);
  }
  console.log("app: device signed in", thumbprint.slice(0, 8), "for", user.id);
  return json({ deviceId: thumbprint, login: user.login, name: user.name });
}

interface DeviceRow {
  device_id: string;
  user_id: string;
  public_jwk: string;
  last_used_at: number;
}

/** Verifies the signed call, its jti, the device and its owner's access. */
async function authenticate(request: Request, env: Env, url: URL): Promise<{ device: DeviceRow; user: SessionUser } | Response> {
  let device: DeviceRow | null = null;
  let a;
  try {
    a = await verifyDeviceAssertion({
      authorization: request.headers.get("Authorization"),
      method: request.method,
      htu: `${env.RELAY_ORIGIN}${url.pathname}`,
      aud: env.RELAY_ORIGIN,
      now: nowSeconds(),
      resolveKey: async (iss) => {
        device = await env.DB.prepare("SELECT device_id, user_id, public_jwk, last_used_at FROM devices WHERE device_id = ?").bind(iss).first<DeviceRow>();
        return device ? parseDeviceJwk(JSON.parse(device.public_jwk)) : null;
      },
    });
  } catch (e) {
    if (e instanceof DeviceAuthError) return authFailure(e);
    throw e;
  }
  const d = device as DeviceRow | null;
  if (!d || nowSeconds() - d.last_used_at > DEVICE_IDLE_SECONDS) return authFailure(new DeviceAuthError("unknown_device"));
  if (!(await consumeJti(env, d.device_id, a.jti, a.exp))) return authFailure(new DeviceAuthError("replayed_jti"));
  const user = await env.DB.prepare("SELECT id, login, name FROM users WHERE id = ?").bind(d.user_id).first<SessionUser>();
  if (!user || !(await isUserAllowed(env, user.id, user.login))) return json({ error: "no_access" }, 403);
  const now = nowSeconds();
  if (now - d.last_used_at > LAST_USED_REFRESH_SECONDS) {
    await env.DB.prepare("UPDATE devices SET last_used_at = ? WHERE device_id = ?").bind(now, d.device_id).run();
  }
  return { device: d, user };
}

/**
 * Signs a device out: deletes it and, in the same transaction and only if it was deleted, signs
 * everyone out of the robots its owner owns (session epoch + 1). The app may hold robot sessions
 * of up to 12 hours; this ends them. Robots the person only views are not touched (that would
 * sign their owner and everyone else out); their owner can sign everyone out. Returns whether
 * this call deleted the device.
 */
export async function signOutDevice(env: Env, deviceId: string, userId: string): Promise<boolean> {
  const [del] = await env.DB.batch([
    env.DB.prepare("DELETE FROM devices WHERE device_id = ? AND user_id = ?").bind(deviceId, userId),
    env.DB.prepare(
      `UPDATE robots SET session_epoch = session_epoch + 1, updated_at = ?2
       WHERE changes() > 0 AND status = 'claimed'
         AND robot_id IN (SELECT robot_id FROM members WHERE user_id = ?1 AND role = 'owner')`,
    ).bind(userId, nowSeconds()),
  ]);
  return del?.meta.changes === 1;
}

async function markFirstOnline(env: Env, robotId: string): Promise<void> {
  await env.DB.prepare("UPDATE robots SET first_online_at = ? WHERE robot_id = ? AND first_online_at IS NULL").bind(nowSeconds(), robotId).run();
}

/** /v1/app/*: the signed JSON API. Returns null for other paths. */
export async function handleAppApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/app/")) return null;
  if (!appEnabled(env)) return json({ error: "not_found" }, 404);
  const method = request.method;
  const path = url.pathname;

  if (path === "/v1/app/token") return method === "POST" ? token(request, env, url) : json({ error: "method_not_allowed" }, 405, { Allow: "POST" });

  const grantPath = /^\/v1\/app\/robots\/([^/]+)\/grant$/.exec(path);
  const known = path === "/v1/app/me" || path === "/v1/app/robots" || path === "/v1/app/claim" || path === "/v1/app/sign-out" || grantPath;
  if (!known) return json({ error: "not_found" }, 404);
  const wantPost = path !== "/v1/app/me" && path !== "/v1/app/robots";
  if (method !== (wantPost ? "POST" : "GET")) return json({ error: "method_not_allowed" }, 405, { Allow: wantPost ? "POST" : "GET" });

  const auth = await authenticate(request, env, url);
  if (auth instanceof Response) return auth;
  const { device, user } = auth;

  if (path === "/v1/app/me") {
    return json({ login: user.login, name: user.name, robotLimit: await robotLimit(env, user.id), robots: await ownedRobots(env, user.id) });
  }

  if (path === "/v1/app/sign-out") {
    // A concurrent sign-out may have won; either way this device is gone and its sessions ended.
    await signOutDevice(env, device.device_id, user.id);
    return json({ ok: true });
  }

  if (path === "/v1/app/robots") {
    const rows = await env.DB.prepare(
      `SELECT r.robot_id, r.name, r.hostname, m.role, m.label, r.allow_teleop, r.tunnel_id, r.agent_version, r.first_online_at
       FROM members m JOIN robots r ON r.robot_id = m.robot_id
       WHERE m.user_id = ? AND r.status = 'claimed' ORDER BY m.created_at`,
    )
      .bind(user.id)
      .all<{ robot_id: string; name: string | null; hostname: string | null; role: string; label: string | null; allow_teleop: number | null; tunnel_id: string | null; agent_version: string | null; first_online_at: number | null }>();
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
        };
      }),
    );
    return json({ robots });
  }

  if (grantPath) {
    const robotId = grantPath[1]!;
    if (!isRobotId(robotId)) return json({ error: "not_found" }, 404);
    const row = await env.DB.prepare(
      `SELECT r.hostname, r.session_epoch, r.tunnel_id, r.first_online_at, m.role
       FROM members m JOIN robots r ON r.robot_id = m.robot_id
       WHERE m.robot_id = ? AND m.user_id = ? AND r.status = 'claimed'`,
    )
      .bind(robotId, user.id)
      .first<{ hostname: string | null; session_epoch: number; tunnel_id: string | null; first_online_at: number | null; role: "owner" | "viewer" }>();
    if (!row) return json({ error: "not_found" }, 404); // non-members and unknown robots alike
    if (!row.hostname) return json({ error: "robot_starting" }, 503, { "Retry-After": "10" });
    const prov = createProvisioner(env);
    const up = row.tunnel_id && prov.connected ? await prov.connected(row.tunnel_id) : null;
    if (up === false) return json({ error: "robot_offline" }, 503, { "Retry-After": "5" });
    if (up && row.first_online_at === null) await markFirstOnline(env, robotId);
    const now = nowSeconds();
    const grant = await mintGrant(env, { robotId, userId: user.id, name: user.name ?? user.login, role: row.role, epoch: row.session_epoch }, now);
    return json({ grant, hostname: row.hostname, expiresAt: now + 60 });
  }

  // /v1/app/claim
  const body = await readJson(request);
  if (!body || typeof body.code !== "string") return json({ error: "bad_request" }, 400);
  const label = cleanLabel(body.label);
  if (body.step === "preview") {
    const prev = await previewClaim(env, user.id, body.code.slice(0, 64));
    if (!prev.ok) return json({ error: prev.status === 429 ? "rate_limited" : "invalid_code", message: prev.message }, prev.status);
    const full = await reachedLimit(env, user.id);
    if (full !== null) return json({ error: "robot_limit", message: limitMessage(full) }, 403);
    const plan = await planAddress(env, createProvisioner(env), prev.robotId, label ?? prev.name);
    return json({ robotId: prev.robotId, name: prev.name, hostname: plan?.hostname ?? null, taken: plan?.taken ?? null });
  }
  if (body.step !== "confirm") return json({ error: "bad_request" }, 400);
  const res = await claimRobot(env, createProvisioner(env), user.id, body.code.slice(0, 64), label);
  if (!res.ok) return json({ error: res.status === 429 ? "rate_limited" : res.status === 403 ? "robot_limit" : "claim_failed", message: res.message }, res.status);
  const r = await env.DB.prepare("SELECT hostname FROM robots WHERE robot_id = ?").bind(res.robotId).first<{ hostname: string | null }>();
  return json({ robotId: res.robotId, hostname: r?.hostname ?? null });
}
