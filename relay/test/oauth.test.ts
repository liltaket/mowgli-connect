import { afterEach, describe, expect, it, vi } from "vitest";
import { call, get, ORIGIN, testEnv } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

async function startLogin(returnTo?: string) {
  const res = await get(`/login${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`, null);
  const loc = new URL(res.headers.get("Location")!);
  const state = loc.searchParams.get("state")!;
  const cookie = setCookies(res).find((c) => c.startsWith("__Host-mcr_oauth="))!.split(";")[0]!;
  return { res, loc, state, cookie };
}

function stubGithub(profile: { id: number; login: string; name?: string | null; two_factor_authentication?: boolean | null }) {
  const calls: { url: string; body?: any }[] = [];
  const usedCodes = new Set<string>();
  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    if (url === "https://github.com/login/oauth/access_token") {
      // Like GitHub: each code works once.
      if (usedCodes.has(body.code)) return Response.json({ error: "bad_verification_code" });
      usedCodes.add(body.code);
      return Response.json({ access_token: "gho_fake" });
    }
    if (url === "https://api.github.com/user") return Response.json({ two_factor_authentication: true, ...profile });
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

describe("GitHub OAuth login", () => {
  it("redirects to GitHub with state + PKCE S256 and binds state to the browser", async () => {
    const { res, loc, state } = await startLogin();
    expect(res.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")!.length).toBe(43);
    expect(loc.searchParams.get("scope")).toBe("read:user");
    expect(state.length).toBeGreaterThanOrEqual(43);
    const cookie = setCookies(res)[0]!;
    expect(cookie).toContain(`__Host-mcr_oauth=${state}`);
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Lax; Path=\//);
  });

  it("starting a login writes nothing to the database", async () => {
    const count = async () => (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM oauth_states").first<{ n: number }>())!.n;
    const before = await count();
    for (let i = 0; i < 5; i++) await startLogin();
    expect(await count()).toBe(before);
  });

  it("falls back to / for return paths too long for a cookie", async () => {
    for (const long of ["/" + "x".repeat(4000), "/" + "å".repeat(2000)]) {
      const { res, state, cookie } = await startLogin(long);
      const set = setCookies(res).find((c) => c.startsWith("__Host-mcr_oauth="))!;
      expect(set.length).toBeLessThan(2200);
      stubGithub({ id: 4245, login: "octo-cat" });
      const done = await call(`/auth/github/callback?code=long-${long.length}&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
      expect(done.status).toBe(302);
      expect(done.headers.get("Location")).toBe("/");
    }
  });

  it("rejects expired or malformed login cookies", async () => {
    const { state, cookie } = await startLogin();
    stubGithub({ id: 4244, login: "octo-cat" });
    const [st, ver, , rt] = cookie.slice("__Host-mcr_oauth=".length).split("~");
    for (const bad of [`${st}~${ver}~1~${rt}`, `${st}~short~9999999999~${rt}`, `${st}~${ver}`, "garbage"]) {
      const res = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { Cookie: `__Host-mcr_oauth=${bad}` }, redirect: "manual" });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a callback whose state does not match the browser cookie", async () => {
    const { state } = await startLogin();
    const noCookie = await call(`/auth/github/callback?code=c&state=${state}`, { redirect: "manual" });
    expect(noCookie.status).toBe(400);
    const wrong = await call(`/auth/github/callback?code=c&state=${state}`, { headers: { Cookie: "__Host-mcr_oauth=other" }, redirect: "manual" });
    expect(wrong.status).toBe(400);
  });

  it("completes login: exchanges code with the PKCE verifier, creates a hashed session, returns to return_to", async () => {
    const { state, cookie } = await startLogin("/claim?code=ABCDEFGHJK");
    const calls = stubGithub({ id: 4242, login: "octo-cat", name: "Octo Cat" });
    const res = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/claim?code=ABCDEFGHJK");

    const exchange = calls.find((c) => c.url.endsWith("/access_token"))!.body;
    expect(exchange).toMatchObject({ client_id: "test-client-id", client_secret: "test-client-secret", code: "abc" });
    expect(exchange.code_verifier.length).toBeGreaterThanOrEqual(43);

    const cookies = setCookies(res);
    const session = cookies.find((c) => c.startsWith("__Host-mcr_session="))!;
    expect(session).toMatch(/HttpOnly; Secure; SameSite=Lax; Path=\//);
    const token = session.split(";")[0]!.split("=")[1]!;
    const user = await testEnv.DB.prepare("SELECT id, login FROM users WHERE id = 'gh:4242'").first<{ id: string; login: string }>();
    expect(user).toEqual({ id: "gh:4242", login: "octo-cat" });
    const stored = await testEnv.DB.prepare("SELECT token_hash FROM sessions WHERE user_id = 'gh:4242'").all<{ token_hash: string }>();
    expect(stored.results.map((r) => r.token_hash)).not.toContain(token);

    // A replayed callback fails: GitHub codes are single use (and the browser's cookie is cleared).
    expect(cookies).toContain("__Host-mcr_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    const replay = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(replay.status).toBe(502);
    expect(setCookies(replay).some((c) => c.startsWith("__Host-mcr_session=") && !c.includes("Max-Age=0"))).toBe(false);

    // and the cookie works
    const dash = await call("/", { headers: { Cookie: `__Host-mcr_session=${token}` } });
    expect(await dash.text()).toContain("octo-cat");
  });

  it("refuses GitHub users outside ALLOWED_GITHUB_LOGINS and creates no session", async () => {
    const { state, cookie } = await startLogin();
    stubGithub({ id: 777001, login: "mallory" });
    const res = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" }, { ...testEnv, ALLOWED_GITHUB_LOGINS: "alice" });
    expect(res.status).toBe(403);
    expect(setCookies(res).some((c) => c.startsWith("__Host-mcr_session=") && !c.includes("Max-Age=0"))).toBe(false);
    expect(await testEnv.DB.prepare("SELECT 1 FROM users WHERE id = 'gh:777001'").first()).toBeNull();
  });

  it("refuses accounts without two-factor authentication, or where GitHub does not report it, and creates no session", async () => {
    for (const [i, tfa] of ([false, null, undefined] as const).entries()) {
      const { state, cookie } = await startLogin();
      stubGithub({ id: 777100 + i, login: "no-2fa", two_factor_authentication: tfa });
      const res = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Two-factor authentication");
      expect(setCookies(res).some((c) => c.startsWith("__Host-mcr_session=") && !c.includes("Max-Age=0"))).toBe(false);
      expect(await testEnv.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(`gh:${777100 + i}`).first()).toBeNull();
    }
  });

  it("does not follow open-redirect return_to values", async () => {
    for (const bad of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      const { state, cookie } = await startLogin(bad);
      stubGithub({ id: 4243, login: "octo-cat" });
      const res = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
      expect(res.headers.get("Location")).toBe("/");
    }
  });
});
