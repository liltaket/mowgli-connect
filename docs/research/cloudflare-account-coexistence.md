# Cloudflare free-account coexistence research (relay Worker + D1 + Tunnels)

Researched 2026-11-08. Primary sources: developers.cloudflare.com, cloudflare.com. Anything not confirmed in an official page is marked UNVERIFIED.

## Summary

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | Workers Free 100k/day | Documented as an *account* limit ("Accounts on the Workers Free plan..."); Pages Functions share the same pool; resets 00:00 UTC; over limit -> Error 1027 (fail closed) or bypass Worker (fail open), per-route setting; static assets are free/unlimited and do not count; CPU 10 ms/invocation; no doc says Free ever auto-bills (Paid is an explicit $5/mo subscription) | High, except "never auto-billed" is only implied |
| 2 | D1 Free | 5M rows read/day, 100k rows written/day, 5 GB total storage (500 MB/DB), 10 DBs/account; over limit = queries error, no charge; reset 00:00 UTC; per-account vs per-DB scope of daily limits NOT stated | High / scope UNVERIFIED |
| 3 | Protect Worker | Free WAF rate limiting: 1 rule, IP only, 10 s period/10 s timeout. "WAF runs before Workers so blocked requests are not billed" is NOT in official docs (only community) = UNVERIFIED. workers.dev can be disabled (`workers_dev = false`). `ratelimit` binding exists; Free-plan availability not stated in docs | Mixed |
| 4 | Tunnel | 1,000 tunnels/account, 25 connectors/tunnel; no bandwidth cap documented; Free plans may not serve video/large files via public hostnames; tunnel traffic does not invoke Workers (no doc says it does); proxied CNAME to `<uuid>.cfargotunnel.com` only works for DNS records in the SAME account as the tunnel; Free DNS limit 200 records/zone (1,000 if zone created before 2024-09-01) | High |
| 5 | WS permessage-deflate | No official doc statement either way. UNVERIFIED | - |
| 6 | Edge cache | `.js` is cached by default by extension; `Cache-Control: private` (also no-store/no-cache/max-age=0) prevents caching; `Set-Cookie` in response prevents caching; request Cookie header not mentioned in docs (UNVERIFIED, likely irrelevant). `immutable` is ignored by Cloudflare; needs `public`+`max-age>0` | High / cookie UNVERIFIED |
| 7 | Skills/MCP | Yes: github.com/cloudflare/skills (22 skills + bundled `cloudflare` MCP server); Claude Code install `/plugin marketplace add cloudflare/skills` then `/plugin install cloudflare@cloudflare`; official MCP servers at mcp.cloudflare.com/mcp etc. | High |
| 8 | Registrar | At-cost, no markup; .app price not on official pages fetched. Third-party: ~$14.20/yr renewal. UNVERIFIED officially. Expiry: 30-day Redemption Grace Period after expiry; official docs do not state zone/DNS effect | Medium |
| 9 | DecompressionStream deflate-raw | Chrome 103, Firefox 113, Safari 16.4, Safari iOS 16.4 (mirrors Safari) | High |

**Key risk for the "existing site must never go down" requirement:** if the existing site is a Pages project *with Functions* or a Worker (including Workers Static Assets with `run_worker_first`), exhausting the shared 100k/day pool can take it down (1027 or 429). If it is pure static (Pages static files, Static Assets without a Worker run, or a proxied DNS site to an external origin) it is unaffected by the quota. Mitigation: create the relay in a SEPARATE Cloudflare account (free, no cost) or use fail-open routes; see per-question notes. Note the 1027 fail-open/closed setting is a per-route setting, so it only helps for Worker *Routes*, not Custom Domains/workers.dev (this nuance is UNVERIFIED in docs).

## 1. Workers Free plan

- 100,000 requests/day; resets at midnight UTC; Error 1027 when exceeded; fail open vs fail closed via the route toggle: https://developers.cloudflare.com/workers/platform/limits/ ("Accounts on the Workers Free plan have a daily request limit of 100,000 requests, resetting at midnight UTC." / "When a Worker exceeds this limit, Cloudflare returns Error 1027." Fail open = "Bypasses the Worker. Requests behave as if no Worker is configured."; fail closed = "Returns a Cloudflare 1027 error page").
- Error table: 1027 = "Worker exceeded free tier": https://developers.cloudflare.com/workers/observability/errors/
- Per account: the limits page phrases it as an account-level limit (it is in the "Account plan limits" context); it never writes "per account" for requests explicitly. The pricing page lists 100,000/day for Workers: https://developers.cloudflare.com/workers/platform/pricing/
- Pages Functions share the pool: "Requests to your Pages functions count towards your quota for the Workers Free plan." Example in docs: 50,000 Functions + 50,000 Workers = full 100,000: https://developers.cloudflare.com/pages/functions/pricing/ . Pricing page: "All pricing and inclusions in this document apply to Pages Functions."
- workers.dev vs custom domains: the docs do NOT describe a difference. Whether fail-open applies to custom domains vs routes vs workers.dev: UNVERIFIED (the docs only say "toggling the corresponding route"). A third-party search summary claimed workers.dev requests count toward the same pool as zones; not confirmed in official docs: UNVERIFIED.
- Static assets: "Requests to static assets are free and unlimited": https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ . Pages: static requests (not invoking Functions) are free and unlimited: https://developers.cloudflare.com/pages/functions/pricing/ . Caveat: requests matched by `run_worker_first` are billed as Worker requests, and on Free, once over the limit "these requests will receive a 429 (Too Many Requests) response instead of falling back to static assets" (same Static Assets billing page).
- Reset: 00:00 UTC (limits page).
- CPU: 10 ms per HTTP request (and per Cron Trigger) on Free: https://developers.cloudflare.com/workers/platform/limits/ . Subrequests: 50/invocation on Free.
- Auto-billing: Free is the default plan ("By default, users have access to the Workers Free plan."); Paid is a separate plan with "a minimum charge of $5 USD per month for an account": https://developers.cloudflare.com/workers/platform/pricing/ . No official page found stating Free accounts are automatically upgraded or billed; exceeding limits causes errors, not charges (D1 and KV pages say "will fail with an error"). The absence of auto-billing is inferred, not explicitly stated: UNVERIFIED as a positive statement. Keep no Workers Paid subscription and no payment method on the account to be safe (the account could be on Free regardless).
- Other: 100 Workers per account, 5 cron triggers per account on Free (limits page).

## 2. D1 Free

- Rows read 5 million/day, rows written 100,000/day, storage 5 GB total, 10 databases: https://developers.cloudflare.com/d1/platform/pricing/ and https://developers.cloudflare.com/d1/platform/limits/ (500 MB per database on Free, 5 GB total per account, 10 DBs per account).
- Exceeding daily limits: "you will not be able to run queries against D1"; API returns errors that daily limits were exceeded; reset 00:00 UTC. Storage exceeded: must delete data/DBs before inserting or creating tables.
- Scope of the daily read/write limit (per account vs per database): not stated on the page. UNVERIFIED (assume per account to be safe). Storage total is "based on the sum of all databases in your account".
- No charges on Free; limits block queries. Upgrading to Workers Paid removes the limits.
- Design note: 30 robots polling `GET /v1/robots/self` every N min -> at N=1 that is 43,200 req/day (43% of 100k). Count subrequests/D1 writes carefully; each poll that writes to D1 costs rows written.

## 3. Protecting the Worker

- WAF rate limiting on Free: 1 rule, counting characteristic IP only, 10 s counting period, 10 s mitigation timeout, no custom counting expression: https://developers.cloudflare.com/waf/rate-limiting-rules/ . Free WAF: custom rules available, Free Managed Ruleset: https://developers.cloudflare.com/waf/
- Do WAF-blocked requests count toward Workers quota? Official docs do not state the execution order of WAF vs Workers on the pages I could fetch (https://developers.cloudflare.com/waf/ , https://developers.cloudflare.com/workers/configuration/routing/ were silent). Community thread (not official) asserts Workers run after the firewall and blocked requests are not billed: https://community.cloudflare.com/t/workers-behavior-with-firewall-rules/109182 . Official statement: UNVERIFIED. Related: WAF rate limiting may count Workers same-zone subrequests separately (https://developers.cloudflare.com/waf/rate-limiting-rules/troubleshooting/).
- Disable workers.dev: Dashboard Workers & Pages > Worker > Settings > Domains & Routes > workers.dev > Disable, or `workers_dev = false` in Wrangler config (redeploy; dashboard-only disabling is re-enabled by the next Wrangler deploy unless the config says false; Preview/Version URLs remain): https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- `ratelimit` binding: exists (`simple` type only, period 10 or 60 s, per-Cloudflare-location counters, "approximate", needs Wrangler >= 4.36.0; strict global limits need Durable Objects): https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ . The page says nothing about plan availability or pricing, so Free availability is UNVERIFIED. Note the Worker has already been invoked (and counted) when the binding rejects, so it protects D1, not the daily request quota.

## 4. Cloudflare Tunnel

- Limits: 1,000 tunnels per account, 25 active cloudflared replicas per tunnel, 50,000 routes/account; no separate Free-plan numbers: https://developers.cloudflare.com/cloudflare-one/account-limits/ . 30 robots = 30 tunnels, fine.
- Bandwidth: no numeric cap documented. Free/Pro/Business terms "require you to use a specific paid service to serve video and other large files" over public hostname routes: https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/ . The same FAQ confirms "Cloudflare Tunnel has full support for Websockets."
- Workers/D1 quota: no doc links tunnel traffic to Workers or D1 usage; tunnel hostnames route via the reverse proxy to cloudflared and do not invoke a Worker unless a Worker route/custom domain matches the same hostname (this is the expected behavior but not explicitly stated in docs: UNVERIFIED as explicit statement). Avoid Worker routes like `*.bronc.app/*` that would also match tunnel hostnames.
- Same account: the cfargotunnel subdomain "only proxies traffic for DNS records in the same Cloudflare account": https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/ . So the `bronc.app` zone must be in the same account as the tunnels. Cross-account: Error 1014 "CNAME Cross-User Banned" is the generic error for CNAMEs between accounts (fix: Cloudflare for SaaS): https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014/ . The tunnel docs do not name 1014 explicitly for tunnels; the docs say a cross-account record cannot proxy through the tunnel.
- Free DNS record limit: 200 per zone for Free zones created on/after 2024-09-01 UTC; 1,000 for earlier zones; Pro/Business 3,500: https://developers.cloudflare.com/dns/manage-dns-records/index.md (DNS records quota section). 30 robots needs 30 records.
- Implication: tunnels, `bronc.app` zone and the relay Worker can all live in the account that holds `bronc.app`. Then the question is whether that is the same account as the personal site (shared 100k/day pool). Decision for Bruno: dedicated second free account for bronc.app is the only approach that fully isolates the website from the quota; it costs nothing.

## 5. WebSocket permessage-deflate

- Official WebSocket docs say: "Cloudflare supports proxied WebSocket connections without additional configuration", all plans, idle timeout, WAF does not inspect after connect; no mention of permessage-deflate, Sec-WebSocket-Extensions, or compression: https://developers.cloudflare.com/network/websockets/ . Tunnel FAQ also silent on compression.
- Only evidence: a workerd issue (mirror https://gh.r-mj.com/cloudflare/workerd/issues/6671) reporting the extension header missing from a 101 with explicit regional Worker placement; concerns Workers-originated sockets, not tunnel proxying.
- Verdict: UNVERIFIED either way. Test empirically (inspect `Sec-WebSocket-Extensions` in the 101 response through the tunnel hostname), and make the app work with or without negotiated compression (app-level `deflate-raw` + DecompressionStream is robust).

## 6. Edge caching for tunnel hostnames

- Default caching is by file extension, not MIME; `.js` is in the list; HTML and JSON are not cached by default: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/ . Static content (images, CSS, JS) cacheable by default: https://developers.cloudflare.com/cache/get-started/ . This applies to proxied records including tunnel CNAMEs (assumed; not tunnel-specific in docs).
- Not cached when `Cache-Control` is `private`, `no-store`, `no-cache` or `max-age=0`, when response has `Set-Cookie`, or method is not GET (default-cache-behavior page). Cached when `public` and `max-age > 0` or `Expires` in future. `private`: "must not be stored by a shared cache like Cloudflare": https://developers.cloudflare.com/cache/concepts/cache-control/ . `immutable` "has no effect on public caches like Cloudflare" (same page).
- Request Cookie header: official pages say nothing about default behavior; cookie-based bypass only happens via configured Cache Rules ("Cache rules that bypass cache on cookie", cache/get-started). So by docs a request cookie should not by itself prevent caching of a `.js` file, but explicit statement is UNVERIFIED. Verify with `cf-cache-status`.
- Practical: for per-robot private assets, send `Cache-Control: private, no-store` (or add a Cache Rule bypass for the hostnames) so one robot's response is never served to another.

## 7. Official skills / MCP

- Repo: https://github.com/cloudflare/skills . 22 skills grouped as: discovery (`cloudflare`), frameworks (`frameworks-on-cloudflare`, `nextjs-on-cloudflare`), agents/state (`agents-sdk`, `durable-objects`), sandbox, data (`basin`, `k2`), Workers tooling (`workers-best-practices`, `workers-development`, `workers-profiling`, `wrangler`, `cf-cli`, `cloudflare-app-bootstrap`, `gateway-workers`), email/bot/perf (`cloudflare-email-service`, `turnstile-spin`, `web-perf`), Cloudflare One. Bundles one MCP server `cloudflare` (API + docs via Code Mode). License not stated on the fetched README (UNVERIFIED). Fetched via raw README (the GitHub page itself timed out).
- Install (Claude Code): `/plugin marketplace add cloudflare/skills` then `/plugin install cloudflare@cloudflare`; any Agent Skills agent: `npx skills add https://github.com/cloudflare/skills`; Codex: `codex plugin marketplace add cloudflare/skills`, `codex plugin add cloudflare@cloudflare`. Not installed.
- MCP servers: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/ . Main: `https://mcp.cloudflare.com/mcp` (API; repo https://github.com/cloudflare/mcp). Optional: docs.mcp.cloudflare.com/mcp, containers.mcp..., browser.mcp..., dex.mcp..., casb.mcp..., agents.cloudflare.com/mcp. Client setup repo https://github.com/cloudflare/mcp-server-cloudflare . Auth: OAuth, or API token as bearer for automation.

## 8. Registrar

- Pricing model: "Registration, transfer, and renewal prices are always at or below what registries and ICANN charge us." "Cloudflare Registrar does not mark up domain prices at all.": https://www.cloudflare.com/products/registrar/ . The official page fetched shows no .app price and no price list link.
- .app renewal: UNVERIFIED officially. Third-party price trackers report about $14.20/yr (e.g. https://costgoat.com/compare/domains/app , https://domainoffer.net/tld/app/cloudflare ; first-year figures disagree between sources). Check the Cloudflare dashboard checkout.
- Expiry: auto-renew attempts start ~30 days before expiry, last attempt the day before; if they fail you must renew manually; unrenewed domains enter a 30-day Redemption Grace Period, restoration may cost extra, transfers blocked: https://developers.cloudflare.com/registrar/account-options/renew-domains/ . That page does not say what happens to the zone/DNS/tunnels. Expected result (domain stops resolving once registry removes delegation; tunnels disconnect from the user's perspective) is UNVERIFIED in official docs. Note Cloudflare Registrar requires Cloudflare nameservers (third-party report).

## 9. DecompressionStream('deflate-raw')

Source: MDN browser-compat-data `api/DecompressionStream.json` (the data behind MDN tables), fetched from https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/DecompressionStream.json , entry `"deflate-raw" compression`:
- Chrome 103 (Chrome Android, Edge, Opera, WebView mirror), Firefox 113, Safari 16.4, Safari iOS 16.4 (`mirror` of Safari), Node 21.2.0 / 20.12.0 (with a 21.0.0 removal gap), Deno 1.23, Bun 1.3.3.
- The constructor itself: Chrome 80, Firefox 113, Safari 16.4. MDN page says baseline "widely available since May 2023": https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream . caniuse page fetch returned no feature data.
- Note: `brotli` format not supported in Chrome (not needed).

## Gaps / UNVERIFIED list

1. Whether workers.dev requests share the same pool and how fail-open applies on Custom Domains vs Routes vs workers.dev.
2. Official statement that WAF/rate-limiting rules run before Workers and blocked requests are not billed.
3. `ratelimit` binding availability on Workers Free.
4. D1 daily limits scope (account vs database).
5. Explicit "Free plan is never auto-billed" statement.
6. WebSocket permessage-deflate through the proxy/tunnel.
7. Request Cookie header effect on default caching.
8. Official .app renewal price; zone/DNS effect of expiry.
9. Whether Worker routes can capture tunnel hostnames (design avoidance: do not route `*.bronc.app/*` to a Worker).

## The maintainer's existing account (2026-11-08)

The maintainer's existing free account already hosts a small website, a Worker with static assets
that uses a fraction of a percent of the Free plan's daily Worker requests. It has no D1
databases, tunnels or Worker routes, and it does not hold `bronc.app`. (Inventory details are left
out of this public report.)

Normal relay use fits easily: about 15,000 requests/day at 30 robots, see
[architecture](../architecture.md). It cannot be ruled out, though, that someone floods the
relay's public URL. That would use up the shared 100,000/day pool and make the website's Worker
invocations fail until 00:00 UTC. Static assets stay free, but anything the Worker script handles
would return errors.

**Decision basis:** the only way to guarantee that the relay can never affect the website is a
**separate free Cloudflare account** for Mowgli Connect. That account holds the relay Worker, D1,
the tunnels and, for named mode, the robot zone, because tunnels must be in the same account as
the zone.
