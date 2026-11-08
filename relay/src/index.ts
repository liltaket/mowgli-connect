import type { Env } from "./env";
import { handleBrowser } from "./browser";
import { retryPendingCleanups } from "./claim";
import { page, html, PAIR_JS, SECURITY_HEADERS, STYLE_CSS } from "./html";
import { createProvisioner } from "./provisioner";
import { json, registerRobot, reportHostname, robotSelf } from "./robotApi";
import { nowSeconds } from "./util";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.origin !== env.RELAY_ORIGIN) {
    return new Response("Misdirected Request", { status: 421, headers: SECURITY_HEADERS });
  }

  if (url.pathname === "/style.css" && request.method === "GET") {
    return new Response(STYLE_CSS, { headers: { ...SECURITY_HEADERS, "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  }

  if (url.pathname === "/pair.js" && request.method === "GET") {
    return new Response(PAIR_JS, { headers: { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  }

  // Robot API (assertion-authenticated JSON; no cookies, no Origin semantics).
  if (url.pathname === "/v1/robots/register") {
    return request.method === "POST" ? registerRobot(env, request, url) : json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  }
  if (url.pathname === "/v1/robots/self") {
    return request.method === "GET" ? robotSelf(env, request, url) : json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  }
  if (url.pathname === "/v1/robots/hostname") {
    return request.method === "POST" ? reportHostname(env, request, url) : json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  }
  if (url.pathname.startsWith("/v1/")) return json({ error: "not_found" }, 404);

  const res = await handleBrowser(request, env, url);
  if (res) return res;
  return page("Not found", html`<p>Not found.</p><p><a href="/">Home</a></p>`, 404);
}

export async function runCleanup(env: Env): Promise<void> {
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM jti_seen WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM claim_failures WHERE at < ?").bind(now - 3600),
    // Registration spam: forget robots that never got claimed and stopped calling.
    env.DB.prepare("DELETE FROM robots WHERE status = 'unclaimed' AND last_seen_at < ?").bind(now - 7 * 86400),
  ]);
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      console.error("unhandled error", e instanceof Error ? e.message : "unknown");
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await runCleanup(env);
        try {
          await retryPendingCleanups(env, createProvisioner(env));
        } catch (e) {
          console.error("cleanup retry skipped", e instanceof Error ? e.message : "unknown");
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
