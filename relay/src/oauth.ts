import type { Env } from "./env";
import { b64urlEncode } from "./crypto";
import { page, html } from "./html";
import { createSession, isUserAllowed, sessionCookie } from "./session";
import { nowSeconds, parseCookies, randomToken, safeReturnPath, sha256Hex } from "./util";

const OAUTH_COOKIE = "__Host-mcr_oauth";
const OAUTH_TTL_SECONDS = 600;

function oauthCookie(value: string, maxAge: number): string {
  return `${OAUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export async function startLogin(env: Env, returnTo: string | null): Promise<Response> {
  const state = randomToken(32);
  const verifier = randomToken(32);
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const now = nowSeconds();
  await env.DB.prepare("INSERT INTO oauth_states (state_hash, code_verifier, return_to, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(state), verifier, safeReturnPath(returnTo), now + OAUTH_TTL_SECONDS)
    .run();
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${env.RELAY_ORIGIN}/auth/github/callback`);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("allow_signup", "false");
  return new Response(null, {
    status: 302,
    headers: { Location: u.toString(), "Set-Cookie": oauthCookie(state, OAUTH_TTL_SECONDS), "Cache-Control": "no-store" },
  });
}

function fail(message: string, status = 400): Response {
  return page("Login failed", html`<p class="error">${message}</p><p><a href="/">Back</a></p>`, status, {
    "Set-Cookie": oauthCookie("", 0),
  });
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}

export async function finishLogin(env: Env, url: URL, request: Request): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const cookieState = parseCookies(request.headers.get("Cookie"))[OAUTH_COOKIE];
  if (!state || !code || !cookieState || cookieState !== state) return fail("Invalid login state. Please try again.");

  // Single use: consume atomically.
  const row = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING code_verifier, return_to",
  )
    .bind(await sha256Hex(state), nowSeconds())
    .first<{ code_verifier: string; return_to: string }>();
  if (!row) return fail("Login expired. Please try again.");

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
  if (!isUserAllowed(env, userId, gh.login)) {
    return fail("This GitHub account is not allowed to use this relay.", 403);
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
