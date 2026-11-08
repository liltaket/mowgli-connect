import type { Env } from "./env";
import { page, html, type SafeHtml } from "./html";
import { isUserAllowed } from "./access";
import { createSession, sessionCookie } from "./session";
import { b64urlDecode, b64urlEncode } from "./crypto";
import { nowSeconds, parseCookies, randomToken, safeReturnPath } from "./util";

const OAUTH_COOKIE = "__Host-mcr_oauth";
const OAUTH_TTL_SECONDS = 600;

function oauthCookie(value: string, maxAge: number): string {
  return `${OAUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/**
 * In-flight login state, kept only in the `__Host-` cookie (never in D1, so starting a login
 * costs no database write): `state~verifier~expiresAt~base64url(returnTo)`. The cookie is
 * host-only and HttpOnly, so another site or a robot hostname cannot set or read it; the
 * callback requires the `state` query parameter to match it (login CSRF), and GitHub accepts
 * each code once and only with the matching PKCE verifier.
 */
interface LoginState {
  state: string;
  verifier: string;
  returnTo: string;
}

function encodeLoginState(s: LoginState, expiresAt: number): string {
  return [s.state, s.verifier, String(expiresAt), b64urlEncode(new TextEncoder().encode(s.returnTo))].join("~");
}

// Browsers drop cookies over 4096 bytes; a longer return path falls back to "/".
const MAX_LOGIN_COOKIE = 2048;

function decodeLoginState(raw: string | undefined, now: number): LoginState | null {
  if (raw && raw.length > MAX_LOGIN_COOKIE) return null;
  const parts = raw?.split("~");
  if (!parts || parts.length !== 4) return null;
  const [state, verifier, exp, rt] = parts as [string, string, string, string];
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(verifier) || !(Number(exp) > now)) return null;
  try {
    return { state, verifier, returnTo: safeReturnPath(new TextDecoder().decode(b64urlDecode(rt))) };
  } catch {
    return null;
  }
}

export async function startLogin(env: Env, returnTo: string | null): Promise<Response> {
  const state = randomToken(32);
  const verifier = randomToken(32);
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const expiresAt = nowSeconds() + OAUTH_TTL_SECONDS;
  let cookieValue = encodeLoginState({ state, verifier, returnTo: safeReturnPath(returnTo) }, expiresAt);
  if (cookieValue.length > MAX_LOGIN_COOKIE) cookieValue = encodeLoginState({ state, verifier, returnTo: "/" }, expiresAt);
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${env.RELAY_ORIGIN}/auth/github/callback`);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("allow_signup", "false");
  return new Response(null, {
    status: 302,
    headers: { Location: u.toString(), "Set-Cookie": oauthCookie(cookieValue, OAUTH_TTL_SECONDS), "Cache-Control": "no-store" },
  });
}

function fail(message: string, status = 400, help?: SafeHtml): Response {
  return page(
    "Sign-in failed",
    html`<h1>Sign-in failed</h1><p class="error">${message}</p>${help ?? ""}<p class="actions"><a class="btn primary" href="/login">Try again</a> <a class="btn" href="/">Back to the start</a></p>`,
    status,
    { "Set-Cookie": oauthCookie("", 0) },
  );
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}

export async function finishLogin(env: Env, url: URL, request: Request): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const login = decodeLoginState(parseCookies(request.headers.get("Cookie"))[OAUTH_COOKIE], nowSeconds());
  if (!state || !code || !login || login.state !== state) return fail("Invalid or expired login. Please try again.");
  const row = { code_verifier: login.verifier, return_to: login.returnTo };

  let gh: GithubUser;
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "mowgli-connect-relay" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${env.RELAY_ORIGIN}/auth/github/callback`,
        code_verifier: row.code_verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) return fail("GitHub login failed.", 502);
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "mowgli-connect-relay",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) return fail("GitHub login failed.", 502);
    gh = (await userRes.json()) as GithubUser;
  } catch {
    return fail("GitHub login failed.", 502);
  }
  if (!Number.isInteger(gh.id) || gh.id <= 0 || typeof gh.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(gh.login)) {
    return fail("GitHub returned an unexpected profile.", 502);
  }

  const userId = `gh:${gh.id}`;
  if (!(await isUserAllowed(env, userId, gh.login))) {
    return fail(
      `The GitHub account @${gh.login} has not been invited yet.`,
      403,
      html`<p class="muted">Mowgli Connect is invite-only while it is a prototype. Ask the person who runs it to add your account. Signed in to GitHub with another account? Sign out on github.com first, then try again.</p>`,
    );
  }

  const now = nowSeconds();
  const name = typeof gh.name === "string" ? gh.name.slice(0, 100) : null;
  await env.DB.prepare(
    `INSERT INTO users (id, login, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, last_login_at = excluded.last_login_at`,
  )
    .bind(userId, gh.login, name, now, now)
    .run();

  const token = await createSession(env, userId);
  const headers = new Headers({ Location: safeReturnPath(row.return_to), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionCookie(token));
  headers.append("Set-Cookie", oauthCookie("", 0));
  return new Response(null, { status: 302, headers });
}
