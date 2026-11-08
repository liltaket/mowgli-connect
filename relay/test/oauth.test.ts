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
  return { res, loc, state, cookie: `__Host-mcr_oauth=${state}` };
}

function stubGithub(profile: { id: number; login: string; name?: string | null }) {
  const calls: { url: string; body?: any }[] = [];
  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_fake" });
    if (url === "https://api.github.com/user") return Response.json(profile);
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
    expect(state.length).toBeGreaterThanOrEqual(43);
    const cookie = setCookies(res)[0]!;
    expect(cookie).toContain(`__Host-mcr_oauth=${state}`);
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Lax; Path=\//);
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

    // state is single use
    const replay = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(replay.status).toBe(400);

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

  it("does not follow open-redirect return_to values", async () => {
    for (const bad of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      const { state, cookie } = await startLogin(bad);
      stubGithub({ id: 4243, login: "octo-cat" });
      const res = await call(`/auth/github/callback?code=abc&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
      expect(res.headers.get("Location")).toBe("/");
    }
  });
});
