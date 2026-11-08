# Mowgli Connect: free hostnames for robot tunnels

Research date: 2026-11-08. Tags: **[V]** verified against an official page fetched today, **[U]** unverified (third-party, partial, or not found), **[I]** inference.
Method: official Cloudflare docs were fetched and read in full where noted. Third-party sources are labelled. Nothing here was tested against a live account.

## 0. Bottom line

| Need | Answer |
|---|---|
| Per-robot hostname, 100% free, no domain | Only **Quick Tunnels** (random `*.trycloudflare.com`) or a **free third-party domain** added as a Cloudflare zone. A Cloudflare *named* tunnel public hostname needs a zone. |
| Workers VPC (Worker → tunnel with no public hostname) | Exists, **still beta** (Oct 29 2026 docs), free on the Free plan during beta. **WebSocket and SSE support through it are not documented.** Needs a test. |
| Wildcard `*.workers.dev` | **No.** Worker hosts are `<worker>.<account>.workers.dev`. A Worker name cannot contain a dot. Custom domains and routes need a zone. |
| `*.pages.dev` fronting a tunnel | Nothing documented. Pages Functions are Workers, with the same limits. Not a path to per-robot hostnames. |
| Recommended | (a) Prototype: Quick Tunnel plus a test of Workers VPC. (b) 30 robots free: a free domain as a zone (eu.org if you can wait, DigitalPlat if not). (c) Robust: one cheap `.com` or `.xyz`, about $10-12/yr at cost on Cloudflare Registrar. |

## 1. Cloudflare Quick Tunnels (trycloudflare.com)

Sources: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/ and https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/ (last updated Sep 30 2026).

Verbatim [V]:
- "Quick Tunnels create a temporary `trycloudflare.com` URL for a local service. You do not need a Cloudflare account or domain."
- "Quick Tunnels are for testing and development. For production, create a Cloudflare Tunnel."
- Limitations: "Quick Tunnels have no uptime guarantee." / "Each Quick Tunnel supports up to 200 in-flight requests. Additional requests return a `429` response." / "Quick Tunnels do not support Server-Sent Events (SSE)." / "The hostname changes each time you create a Quick Tunnel."
- "Anyone with the URL can access your local service. The URL stops working when you stop the `cloudflared` process."

Findings:
- **WebSockets:** the docs do not mention them either way [V that the docs are silent]. One third-party write-up (tacticremote.com, Feb 2026) reports an encrypted WebSocket working over a quick tunnel [U]. Test it.
- **SSE:** documented as unsupported [V]. The firmware-flash endpoint (a streamed SSE POST) is the most likely thing to break. [I] The likely failure is response buffering of `text/event-stream`. Redesign the flash progress channel as WebSocket or polling if Quick Tunnels are used.
- **Idle GC:** cloudflared issue #1759 (open, Oct 8 2026) reports tunnels being garbage-collected after about 15 min of inactivity (https://github.com/cloudflare/cloudflared/issues/1759). This is a user observation, not a Cloudflare statement [U]. The agent must watch for tunnel death and restart.
- **Terms:** the docs say "testing and development" and point production users to named tunnels. The Website/Online Services Terms (https://www.cloudflare.com/website-terms/, Aug 2025) and the Self-Serve Subscription Agreement (https://www.cloudflare.com/terms/, Sep 2025) do not mention trycloudflare or Quick Tunnels [V]. The Tunnel-specific Service-Specific Terms were not retrievable [U]. The general terms allow suspension or discontinuation "with or without notice" [V]. Using it for a community service is against the documented intent but I found no explicit prohibition [I].
- **Automation:** feasible [I]. The agent runs `cloudflared tunnel --url http://127.0.0.1:<proxy-port>`, parses the URL from the log (or the local metrics endpoint [U]), and POSTs it to the relay over its authenticated channel. Every restart changes the hostname, so the relay must treat the hostname as soft state with a heartbeat TTL.
- **Risks:**
  - Hostname hijack: a rogue or compromised agent could report an attacker-controlled URL and users get redirected to it. Mitigate by requiring the hostname to match `^[a-z0-9-]+\.trycloudflare\.com$` and having the relay verify a signed challenge served by the robot's auth proxy before redirecting.
  - Reputation: trycloudflare.com is heavily abused for phishing [I]. Expect corporate filters and Safe Browsing warnings.
  - Origin model: each tunnel hostname is its own origin [V by construction], and GUI-at-root and Origin==Host work.
  - Stability: URL changes break bookmarks. The relay must issue the redirect fresh each time.

## 2. Workers VPC (Worker → Tunnel, no public hostname)

Sources (all fetched today): https://developers.cloudflare.com/workers-vpc/index.md (Oct 29 2026), .../configuration/vpc-networks/, .../configuration/vpc-services/, .../configuration/tunnel/, .../platform/pricing/, .../platform/limits/, changelog https://developers.cloudflare.com/changelog/post/2026-04-14-vpc-networks/, blog https://blog.cloudflare.com/workers-vpc-open-beta/.

- **Exists, status:** [V] "Workers VPC is currently in beta. Features and APIs may change before general availability." No GA announcement on any page.
- **Free plan / price:** [V] "Available on Free and Paid plans." "While in beta, Workers VPC is available for free to all Workers plans." "Workers VPC is free during the open beta period. Standard Workers pricing applies for compute time and requests." Post-beta pricing is not published [V that it is absent]. Tunnels are also free in the beta per the blog.
- **HTTP:** [V] `fetch()` is supported through VPC Service and VPC Network bindings. `connect()` (plain TCP only) is supported through VPC Network bindings.
- **WebSocket / SSE / streaming:** [V that "WebSocket" does not appear on any Workers VPC page, nor does SSE.] Not documented, so treat as unknown. This is the key risk for this project and needs a 30-minute spike.
- **Per-robot targeting:**
  - VPC Service binding: one binding per target host+port ("create a separate binding for each target host and port combination") [V]. Limit 1000 VPC Services per account [V].
  - VPC Network binding by `tunnel_id`: the URL passed to `fetch()` picks the destination at runtime [V]. The binding itself is declared in Worker config (`[[vpc_networks]] tunnel_id=...`), and permissions are checked at deploy time. Binding by tunnel UUID requires the Connectivity Directory Admin role [V].
  - [U] No page describes creating or changing network bindings without a redeploy.
  - [I] Per-robot tunnels mean one binding each, so each new robot means a Worker config change and redeploy.
  - The `cf1:network` binding reaches everything on the account's default network without naming tunnels [V]. How a robot's tunnel gets into that network (routes, virtual networks) was not read [U]. This is the likeliest scalable design: one binding, robot chosen by the hostname or IP in the `fetch()` URL.
- **Tunnel requirements:** [V] `cloudflared` ≥ 2025.7.0, QUIC transport (`auto` or `quic`), outbound UDP 7844. Remotely-managed tunnels recommended. Whether `tunnel_id` bindings need private network routes or hostname routes is not stated [U]. [I] Probably yes.
- **Tunnels per account:** [V] 1,000 `cloudflared` tunnels per account, 25 replicas per tunnel (https://developers.cloudflare.com/cloudflare-one/account-limits/). Routes (CIDR + hostname) per account: 50,000, shared with Mesh. Enough for 30+ robots.
- **Workers Free limits that bite** (https://developers.cloudflare.com/workers/platform/limits/, Oct 29 2026) [V]:
  - 100,000 requests/day per account, then Error 1027.
  - 10 ms CPU per HTTP request. Time waiting on `fetch()` does not count.
  - 50 subrequests per invocation.
  - 6 simultaneous connections waiting for response headers.
  - Incoming WebSocket message limit 32 MiB (so ~2 MB MessagePack frames are fine).
  - Incoming HTTP request duration: "Unlimited" while the client stays connected.
- **WebSocket passthrough cost:** the pricing page says "WebSocket connections made to a Worker are charged as a request, representing the initial `Upgrade` connection... WebSocket messages routed through a Worker do not count as requests." [V]. Whether CPU is metered per proxied message is not documented anywhere I read [V that it is absent]. [I] A bare `return fetch(upstreamWsRequest)` that hands back the upstream 101 response should not run Worker JS per message, so it should not consume the 10 ms budget. Do not rely on this without a test. Manual `accept()` + pairing in the Worker does run JS per message.
- **workers.dev constraints:**
  - Format [V]: `<WORKER_NAME>.<ACCOUNT_SUBDOMAIN>.workers.dev`. Labels are alphanumeric and dashes, max 63 characters. The docs never mention wildcard or nested labels. [I] `<robot>.<worker>.<acct>.workers.dev` is not possible.
  - Custom Domains: "do not support wildcard DNS records" and need "an active Cloudflare zone" [V]. Routes need a zone [V]. So no wildcard Worker without a domain.
  - "Your `workers.dev` subdomain is treated as a Free website and is intended for personal or hobby projects that aren't business-critical." Production is recommended on a route or custom domain [V]. This fits a free community service but is an explicit availability disclaimer.
  - Browser Integrity Check cannot be disabled on workers.dev. Default-UA scripts (e.g. Python urllib) get error 1010 [V]. Robot agents must send a descriptive User-Agent.
- **Per-robot origins under workers.dev:**
  - Path routing `/r/<robotId>/` breaks the GUI (needs root, Origin==Host) and puts all robots in one origin [I]. Reject it.
  - Per-robot **Worker** (same code deployed as `mowgli-r-<id>`, giving `mowgli-r-<id>.<acct>.workers.dev`) would give distinct origins. It needs the relay to deploy a Worker per robot through the API. The Free plan's script-count cap was not verified (I recall 100) [U]. All traffic then counts against 100k requests/day shared across the account.
  - Cookies: `workers.dev` is reportedly in the PSL private section [U, from partial read]. If so, `<acct>.workers.dev` is the registrable domain and robots are same-site but different origins. See §6.
- **Verdict:** attractive (no domain, no public tunnel hostname, nothing to expose), but a beta with undocumented WebSocket behaviour, a 100k req/day shared cap, and a redeploy-per-robot or Mesh-routing design. Run a spike before committing.

## 3. Free domains as full Cloudflare zones

**Cloudflare's side** [V]:
- Free plan supports full (NS) setup only: "A primary setup (also known as full) is the most common and the only one available for Free or Pro plans." CNAME/partial setup is Business or Enterprise (https://developers.cloudflare.com/dns/zone-setups/partial-setup/).
- Rule: "Cloudflare requires your apex domain to be one level below a valid TLD defined in the Public Suffix List (PSL)." Subdomain setup is Enterprise (https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/).
- **Open question:** whether `x.eu.org` and `x.dpdns.org` onboard as zones. The docs are ambiguous. `eu.org` and `dpdns.org` appear to be PSL private-section entries [U, partial read of the PSL]. Third-party tutorials say dpdns.org works with Cloudflare, with early restrictions [U]. Many people run eu.org zones on Cloudflare [U, anecdotal]. **Do the 5-minute test:** "Add a domain" on a Free account.
- Universal SSL [V]: for a full-setup zone, coverage is "the root domain and first-level subdomains". So zone `mowgli.dpdns.org` covers `<robotId>.mowgli.dpdns.org` (first level below the zone). Deeper names are not covered. The record must be Proxied. Free gets an ECDSA cert.
- Per-robot DNS records can be created by the relay through the API when a tunnel is created. No wildcard is needed.

**Providers:**

| Provider | Cost / limits | Approval | NS to Cloudflare? | Risk / longevity |
|---|---|---|---|---|
| **DigitalPlat FreeDomain** (`.dpdns.org`, `.qzz.io`, `.xx.kg`, `.qd.je`; us.kg reportedly suspended for abuse [U, Apr 2026 aggregator]) | Free. Default limit "1 domain per user account" (FAQ). Fees/slots "can change" | Not documented. Third-party reports vary [U] | Yes. Docs describe delegating to external DNS and use Cloudflare as the example (https://github.com/DigitalPlatDev/FreeDomain, docs/tutorial/1.3-connect-nameservers.md) [V] | Young project. "Correct external DNS records cannot restore a registration-level delegation that is no longer active" [V]. Abuse contact response "a few hours to several days" [V]. README says its old Telegram account was compromised [V]. Suffixes are popular with phishers, so blocklist risk is high [I]. Nameserver flakiness was reported once [U]. |
| **eu.org** | Free, volunteer-run, since the 1990s. Commercial use "VERY STRONGLY" discouraged (https://nic.eu.org/) [V] | Site says "can take a few days" (https://nic.eu.org/register.html) [V]. Forum reports range from weeks to years [U] | Allowed in practice. Step 4: "Configure your nameserver(s)" first [V]. Cloudflare not named | Best longevity and reputation of the free options [I]. Spam/phishing/malware prohibited [V]. Slow and unpredictable. No support channel [U]. |
| **pp.ua** | "either for a fee or free of charge", set by the accredited registrar [V]. Delegated 1 year, renewable | SMS confirmation; deleted after 5 days if unconfirmed [V] | Policy does not restrict NS provider [V] | Policy bans "redirecting Internet users to other domains" and parking, and the administrator can block without notice [V]. Fine of ~5 units to reactivate. Ukrainian registrar. Not recommended. |
| **is-a.dev** | Free subdomains by PR (https://github.com/is-a-dev/register) | Staff review, no SLA [V] | NS record type listed as supported, "Refer to the FAQ for guidance on valid use cases" (https://docs.is-a.dev/domain-structure/) [V]. FAQ not read [U] | Intended for developer portfolios. A NS-delegated zone is probably out of scope [I]. It is also a subdomain of `is-a.dev`, so Cloudflare Free zone acceptance is doubtful. Skip. |
| **js.org** | Free | n/a | "allocation of new ns records is discontinued" [V] | Content must be JS-ecosystem related [V]. Not usable. |
| **afraid.org** | Free subdomains on their DNS | n/a | Hosted on afraid.org nameservers, not delegable to Cloudflare [V, per FAQ reading] | Not a Cloudflare-zone route. |

Notes:
- DigitalPlat's 1-domain limit is fine, since one zone hosts all robots as `<id>.<zone>`.
- Free-domain approach concentrates risk: if the registration lapses or is revoked, every robot disappears at once.

## 4. Pages / other free Cloudflare hostnames

- `*.pages.dev`: [V] custom domains on a subdomain do not require your own zone (CNAME to `<site>.pages.dev`), apex domains do. Pages free limits: 100 projects, 100 custom domains per project, 500 builds/month. Pages Functions count against Workers quotas ("Requests to Pages functions count towards your quota for Workers plans").
- No page documents a Pages project or Function proxying to a tunnel hostname or `cfargotunnel.com`. Not found either way [U]. Even if it worked, a tunnel public hostname needs a zone, so Pages adds nothing over Workers.
- Pages is not formally deprecated, but docs say "Start new projects with Workers" [V]. The migration guide notes that Workers do not support custom domains outside Cloudflare-managed zones while Pages does [V], which is irrelevant here (still needs the domain).
- `*.pages.dev` is a single `<project>` label. Branch/preview aliases add a label but are not dynamic per robot [I, from memory, U]. Not viable.
- `*.cfargotunnel.com`: the tunnel UUID hostname is only a DNS target for proxied CNAMEs and is not reachable directly [I, from memory, U].

## 5. Reliability and size limits for the named-tunnel path (any domain)

Sources: https://developers.cloudflare.com/network/websockets/ and https://developers.cloudflare.com/fundamentals/reference/connection-limits/ [V]
- "WebSockets are supported on all Cloudflare plans." Idle close occurs "when no data is transmitted in either direction for a period of time" (no number published). Heartbeats are recommended.
- Proxy Read Timeout 125 s (524), Idle 900 s (520), Write 30 s (524). Which applies to SSE or a long flashing POST is not stated [U]. Send keepalive bytes during flashing.
- WebSocket message size and SSE behaviour through named tunnels are not documented [U]. Test with a ~2 MB frame.
- Cloudflare code releases "may restart servers, which terminates WebSockets connections", so clients need auto-reconnect.
- Free/Pro/Business service-specific terms restrict serving video and other large files without a paid service [V]. The GUI's JSON/MessagePack is fine. Do not proxy camera video streams through it. [U] Check this if the GUI shows a live video feed.

## 6. Security trade-offs

- **Origin per robot** is required for the GUI and for cookie isolation. All of the options below give one origin per robot: Quick Tunnel hostnames, `<id>.<zone>`, per-robot Workers.
- **Same-site is not the same as same-origin.** If robots are `<id>.<zone>` and the zone is a PSL entry or an ordinary registrable domain, they are same-site. A compromised robot GUI can send credentialed requests to other robots' origins, and `SameSite=Lax/Strict` will not stop it. Quick Tunnel hostnames are probably not same-site with each other (trycloudflare.com is probably a PSL entry [U]).
- Mitigations [I]:
  - Cookies are host-only (never set `Domain`), prefixed `__Host-`.
  - Auth is a robot-bound short-lived grant (audience = robotId) exchanged once via redirect from the relay (cross-site, `*.workers.dev`).
  - The auth proxy rejects tokens whose audience is a different robot.
  - `Origin`/`Sec-Fetch-Site` checks on the proxy.
  - Strict CSP on the robot GUI.
- A Quick-Tunnel URL is an unguessable-ish but public hostname, "anyone with the URL can access" [V], so the auth proxy is the only gate. This is already the design. Make sure the proxy rate-limits login and does not reveal robot identity.
- Free-domain reputation risk affects user trust (phishing warnings) more than technical security.
- Third-party-account risk: all tunnels live in the owner's Cloudflare account. A leaked tunnel token lets an attacker run a connector for that robot's tunnel and impersonate its origin, but the auth proxy and grants still apply because grants are validated at the robot. Store tokens only on the robot and the relay, and keep per-robot tunnels revocable.

## 7. Recommendations

**(a) Zero-cost prototype today (1 robot).**
1. Agent starts a Quick Tunnel to the local auth proxy and reports the URL to the relay with a signed challenge. The relay redirects the browser to it. Zero setup.
2. Same day: add a Workers VPC spike (one Worker, `fetch()` to the robot over a named tunnel with a private route) to settle whether WebSocket upgrades and streaming POST work through it. It costs nothing and answers whether a no-domain design is possible.
3. Known gaps to handle: SSE flashing is unsupported, hostnames change, possible ~15 min idle GC, trust/reputation issues. Use only for you and testers.

**(b) Zero-cost path for 30 robots.**
- Preferred: apply to **eu.org** now (it is slow, so start immediately) and in parallel register a **DigitalPlat** domain as the immediately usable zone. First confirm in a Cloudflare Free account that the chosen name is accepted as a zone. Then one tunnel per robot (well within the 1,000-tunnel limit) and a DNS record `<robotId>.<zone>` per tunnel, created via the Cloudflare API by the relay. The design is otherwise unchanged. Keep the hostname base configurable so you can move domains later, because the robots re-register.
- Alternative if the Workers VPC spike succeeds: a single Worker plus the `cf1:network` binding (or a Worker per robot for distinct origins). No domain and no public tunnel hostnames. It remains beta with undocumented post-beta pricing, and all traffic is subject to Free-plan 100k requests/day and the workers.dev "hobby" status. Treat as a bet, not a base.
- Risks to accept: abuse-driven delegation loss on DigitalPlat, eu.org approval delay, blocklisting of free suffixes.

**(c) Cheapest robust.**
- Register a cheap TLD on Cloudflare Registrar (at cost, no markup, https://developers.cloudflare.com/registrar/). Third-party price table (cfdomainpricing.com, 2026-11-07, not Cloudflare's own) [U]: `.com` $10.46/yr (renews $10.46), `.xyz` $12.30 (renews $11.20), `.net` $11.86, `.org` $8.50 (renews $11.20), `.dev` $8.20 (renews $12.20), `.online` $4.99 (renews $27.70, avoid). `.se` was not in Cloudflare's TLD list as read, so it is probably not offered [U].
- Recommendation: `.com` at ~$10.5/yr, which has the best reputation and flat renewals. Pick `.org` or `.dev` only if cheaper at checkout. About $0.9/month for the whole fleet. Everything else in the current design works unchanged.

## 8. Items still unverified (all testable in under a day)

1. Whether Cloudflare Free accepts `<name>.dpdns.org` and `<name>.eu.org` as zones (and issues Universal SSL).
2. Quick Tunnel WebSocket behaviour (binary 2 MB frames), idle GC timing, and what happens to a streamed `text/event-stream` POST.
3. Workers VPC `fetch()` with `Upgrade: websocket`, streaming bodies, and CPU consumption per proxied message on the Free plan.
4. Workers Free script-count cap (relevant to per-robot Workers).
5. DigitalPlat and eu.org current approval times and acceptable-use text.
6. Tunnel-specific Cloudflare Service-Specific Terms (not retrievable here).

## Sources

Cloudflare official: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/ · https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/ · https://developers.cloudflare.com/workers-vpc/ (+ configuration/vpc-networks, vpc-services, tunnel, platform/pricing, platform/limits) · https://developers.cloudflare.com/changelog/post/2026-04-14-vpc-networks/ · https://blog.cloudflare.com/workers-vpc-open-beta/ · https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/workers/platform/pricing/ · https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ · https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ · https://developers.cloudflare.com/workers/configuration/routing/routes/ · https://developers.cloudflare.com/workers/runtime-apis/websockets/ · https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/ · https://developers.cloudflare.com/dns/zone-setups/partial-setup/ · https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/ · https://developers.cloudflare.com/pages/configuration/custom-domains/ · https://developers.cloudflare.com/pages/platform/limits/ · https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/ · https://developers.cloudflare.com/cloudflare-one/account-limits/ · https://developers.cloudflare.com/network/websockets/ · https://developers.cloudflare.com/fundamentals/reference/connection-limits/ · https://developers.cloudflare.com/registrar/ · https://www.cloudflare.com/website-terms/ · https://www.cloudflare.com/terms/
Other: https://github.com/cloudflare/cloudflared/issues/1759 · https://github.com/DigitalPlatDev/FreeDomain · https://nic.eu.org/ · https://nic.eu.org/register.html · https://pp.ua/eng/policy.html · https://docs.is-a.dev/domain-structure/ · https://cfdomainpricing.com/ (third-party prices) · https://publicsuffix.org/list/public_suffix_list.dat (partly read) · https://tacticremote.com/blog/2026-02-28-cloudflare-tunnel-remote-development/ (third-party)
