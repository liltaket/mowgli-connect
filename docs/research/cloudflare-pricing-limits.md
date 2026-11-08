# Mowgli Connect: Cloudflare pricing and limits research

Research date: 2026-11-07. Method: official Cloudflare docs, pricing and legal pages were read directly (each page's "last updated" date is given where the page showed one). Third-party pages were used only for exchange rates and domain prices, and are labelled as such.

Legend: **[V]** verified on an official page. **[S]** secondary source only. **[U]** unverified or not found. **[I]** my inference or design recommendation, not a vendor statement.

Currency: 1 USD is about 9.8 SEK **[S]** (one converter page, 2026-11-04; other sources 9.4–9.6, forecasts about 10–10.4). 1 EUR is about 11 SEK **[U]**, assumed for the Hetzner figures only. All SEK numbers are rough.

---

## 0. Executive summary

- **Cloudflare Tunnel is free on all plans** [V]. The account limit is 1,000 tunnels. Each robot runs its own tunnel, so 1,000 robots fits exactly, and each tunnel above that is $4.50/month through Tunnels for Platforms [V].
- **Cloudflare Access is not a fit for a multi-tenant service** [V, with [I] on the conclusion]. Free is capped at 50 users, and over that the only plan is pay-as-you-go at $7 per user per month. 1,000 end users would cost about $7,000/month.
- **Recommended design** [I]:
  - One named, remotely-managed tunnel per robot, created through the API.
  - A first-level hostname per robot, `<robot-id>.example.com`, so free Universal SSL covers it.
  - A Worker control plane (Workers Free, plus D1) for login, pairing and short-lived tokens.
  - The robot itself verifies the signed token. Neither the Worker nor Access is in the data path.
- **Cost:** about 8 SEK/month (domain only) for 1 or 30 robots, and about 8–60 SEK/month for 1,000 robots.
- **Open risks:**
  - The WebSocket idle timeout is not documented.
  - Wildcard tunnel hostnames are not documented.
  - The DNS record limit per zone is not found.
  - The terms ask for care about reselling access (section 1.4).
  - Whether a hosted 29 SEK/month tier is acceptable under the Free-plan terms is a gray area. The safest reading is to ask Cloudflare in writing before charging money.

---

## 1. Cloudflare Tunnel (cloudflared) on the Free plan

### 1.1 Cost and availability
- The Tunnel page says "Available on all plans" [V]: https://developers.cloudflare.com/tunnel/ (updated 2026-09-11). No separate Tunnel price appears there.
- Each tunnel keeps four long-lived connections to two Cloudflare data centers [V] (same page).

### 1.2 Limits [V]
Source: https://developers.cloudflare.com/cloudflare-one/account-limits/ (updated 2026-11-05).

| Limit | Value |
|---|---|
| `cloudflared` tunnels per account | 1,000 |
| Routes (CIDR plus hostname) per account | 50,000 (shared with Cloudflare Mesh) |
| Active `cloudflared` replicas per tunnel | 25 |
| Published applications per tunnel | limited by 1 MB configuration size |
| Virtual networks per account | 1,000 |

The routing page adds "A single remotely-managed tunnel supports roughly 5,000–10,000 published applications" [V]: https://developers.cloudflare.com/tunnel/routing/ (updated 2026-10-16).

An earlier search snippet showed a different route figure (1,000) on a preview copy of the account-limits page. The live page says 50,000, so the preview copy is treated as stale.

- **Bandwidth cap:** none found on any page read [U]. It is not documented either way.
- **Tunnel-specific API rate limit:** not found [U]. The global limit is 1,200 requests per 5 minutes per user, with HTTP 429 above it [V]: https://developers.cloudflare.com/fundamentals/api/reference/limits/. The Tunnels for Platforms page says to retry 429 and 5xx responses with exponential backoff and jitter.

### 1.3 WebSockets, timeouts and body size

**WebSockets**
- "Cloudflare supports proxied WebSocket connections without additional configuration" and "WebSockets are supported on all Cloudflare plans" [V]: https://developers.cloudflare.com/network/websockets/ (updated 2026-08-14).
- Cloudflare closes a WebSocket "when no data is transmitted in either direction for a period of time". **The length of that period is not documented** [V/U]. Enterprise customers can configure it. The page recommends a client-side ping/pong heartbeat.
- Cloudflare releases can restart servers and terminate WebSockets, so the client must reconnect.

**Timeouts**
- The proxy read timeout is **125 s, not 100 s** [V]: https://developers.cloudflare.com/fundamentals/reference/connection-limits/ (updated 2026-10-22). It returns a 524, and is configurable only on Enterprise zones.
- Other timeouts on that page [V]: proxy idle timeout 900 s (520), proxy write timeout 30 s, client keep-alive 400 s.
- No tunnel-specific read or WebSocket idle timeout is listed [U].
- **Recommendation** [I]: send an application-level ping every 20–30 s. That is conservative against both the unknown idle period and the 125 s read timeout.

**Request body size**
- Max upload on Free is 100 MB (Pro 100 MB, Business 200 MB, Enterprise up to 5 GB) [V]: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/. That page does not mention Tunnel, so applicability to tunnel traffic is inferred, but a proxied hostname is the same edge path [I].
- Request URL limit is 16 KB. Request and response headers are limited to 128 KB each [V] (connection-limits page).

### 1.4 Terms of service on non-HTML, binary and streaming content
- The old Section 2.8 (the "non-HTML content" rule) no longer exists in the Self-Serve Subscription Agreement [V]: https://www.cloudflare.com/terms/ (last updated 2025-09-12 on the page).
- Cloudflare's own explanation says it moved "the content-based restriction concept to a new CDN-specific section" and "got rid of the antiquated HTML vs. non-HTML construct" [V]: https://blog.cloudflare.com/updated-tos/ (published 2023-05-16, modified 2026-07-15).
- The current clause sits in the Application Services terms, "Content Delivery Network (Free, Pro, or Business)" [V]: https://www.cloudflare.com/service-specific-terms-application-services/ (updated 2026-09-28). It says that unless you are Enterprise, you must use specific paid Cloudflare services to "serve video and other large files via the CDN". Cloudflare can restrict you if you serve "video or a disproportionate percentage of pictures, audio files, or other large files" without them.
- The Tunnel routing page itself repeats this for Free, Pro and Business [V]: https://developers.cloudflare.com/tunnel/routing/. So the rule is understood to apply to tunnel-routed, proxied hostnames.
- **Assessment** [I]: MessagePack over REST and WebSockets (about 10–200 KB/s of map and LiDAR data) is neither video nor large files, so it is a low risk under the text. Tunnel and cloudflared are not named in the CDN clause [U]. Keep MJPEG or camera video out of this path, or the restriction becomes relevant.
- **Reselling and third-party access.** These terms need attention before a paid hosted tier:
  - Self-Serve section 2.2.1(a): you may not "rent, lease, loan, export, or sell access to the Services to any third party" without Cloudflare's written permission [V].
  - Zero Trust section 2.2: "You shall not resell Cloudflare Zero Trust to any third parties ... unless expressly permitted by Cloudflare in writing" [V]: https://www.cloudflare.com/service-specific-terms-zero-trust-services/.
  - "Zone" definition: Services are for zones with domains owned by the customer, and you may not configure zones for end customers' domains [V]. That is fine here, because the domain is yours.
  - Free services can be terminated "in our sole discretion", with no liability for harm [V] (Self-Serve section 2.6).
  - There is no employees-only restriction. "Seat" includes contractors and "other third party" users authorized by you [V].
  - Whether a hosted 29 SEK/month tier that runs customers' robots through your tunnels counts as "selling access to the Services" is a **legal gray area** [I]. This is not legal advice. The realistic path is to ask Cloudflare (sales or support) before charging money.

### 1.5 Remotely-managed tunnels via API with a token
Source: https://developers.cloudflare.com/tunnel/setup/ (the "Get started" content, updated 2026-09-30) [V].

1. Create the tunnel: `POST /accounts/{account_id}/cfd_tunnel` with `{"name": "...", "config_src": "cloudflare"}`. The token needs at least one of: Cloudflare One Connectors Write, Cloudflare One Connector: cloudflared Write, or Cloudflare Tunnel Write. The response contains the `id` and `token`.
2. Set ingress: `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`. The rules must end with a catch-all.
3. Create DNS: `POST /zones/{zone_id}/dns_records` with a proxied CNAME to `<TUNNEL_ID>.cfargotunnel.com` (needs DNS Write).
4. Run on the robot: `cloudflared service install <TUNNEL_TOKEN>` or `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <TUNNEL_TOKEN>`.

- A separate "get token" endpoint was not on the page read [U]. The create response is documented as returning the token.
- **Security note** [I]: the tunnel token lets whoever holds it run that tunnel. Treat it as a per-robot secret, deliver it only during pairing, and never log it.

---

## 2. Tunnels for Platforms and per-account tunnel limits

Source: https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/ (updated 2026-10-16) [V].

- **What it is:** "lets you run more than 1,000 Cloudflare Tunnels in a single Cloudflare account". It is aimed at SaaS providers, IoT and device makers, and AI agent platforms.
- **Included:** "Every account includes 1,000 tunnels at no cost." This is the same number as the normal per-account limit of 1,000 [V]. The "1,000 included tunnels" claim is therefore confirmed.
- **Price:** "$4.50 per additional tunnel per month." Purchases are made in the dashboard (Networking > Tunnels > Usage card > "Buy more tunnels"). Enterprise customers can instead buy committed capacity or usage-based billing.
- **Requires Enterprise?** The page does not say so [U], and describes a self-serve dashboard purchase. Treat "no Enterprise needed" as likely but unconfirmed.
- **Counting:** every tunnel counts, including inactive ones. At the limit, creation requests fail while existing tunnels keep working. Delete tunnels for robots that unpair.
- **Related limits:** 50,000 routes per account, 25 replicas per tunnel [V].
- **Same tooling:** it uses the same `cloudflared` and API. The page recommends automating the tunnel lifecycle through the API or Terraform.

---

## 3. Cloudflare Access (Zero Trust)

### 3.1 Plans and seats [V]
Source: https://www.cloudflare.com/plans/sase-zero-trust.md.
- **Free:** $0 "forever", "50 users", described as "Teams under 50 users or enterprise proof-of-concept tests". Log retention up to 24 hours. Community support only.
- **Pay-as-you-go:** $7 per user per month, no user limit, 30 days of logs.
- **Contract:** custom pricing.
- **Seat counting** (https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/, updated 2026-05-01): "A user consumes a seat when they perform an authentication event", including any Access login. A seat is held until you remove the user, and seat expiry is configurable from one month to one year. Inactive users do not count towards billing.
- **Over the cap:** "additional users who attempt to log in are blocked" [V].
- It is not stated whether OTP logins consume seats [U]. They are Access authentication events, so assume yes [I].

### 3.2 Limits [V]
Source: https://developers.cloudflare.com/cloudflare-one/account-limits/ (the table is not split by plan; "may be increased on Enterprise accounts").

| Item | Limit |
|---|---|
| Access applications | 500 |
| Reusable policies | 500 |
| Rules per application | 1,000 |
| Email addresses per rule | 1,000 |
| Domains per application | 50 |
| Identity providers | 50 |
| Service tokens | 50 |

No cap was found for policies per application [U].

### 3.3 Login methods and JWT
- **One-time PIN:** emailed only if a policy already allows the address. It expires after 10 minutes and is single-use [V]: https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/. New organisations default to the Cloudflare identity provider, and OTP is no longer added automatically.
- **Identity providers:** all SAML and OIDC providers are supported, plus most OAuth providers [V]. A per-IdP plan matrix was not found [U].
- **Self-hosted apps on tunnel hostnames:** supported. Apps are deny-by-default. Wildcards are allowed in the app domain, and Access checks every HTTP request for a valid application token [V]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/.
- **JWT validation** [V]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/:
  - Validate the `Cf-Access-Jwt-Assertion` header, preferred over the `CF_Authorization` cookie.
  - Keys are at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, and rotate every 6 weeks with a 7-day overlap.
  - Check the issuer and the per-app AUD tag.
- **WebSockets and Access:** whether an open WebSocket is re-checked when the token expires is not documented [U].
- **Session length:** 15 minutes to 1 month globally, default 24 hours [V].

### 3.4 Can each user own their robot's policy? Is it multi-tenant suitable?
- **Technically:** yes, per-user email allow-lists are supported and can be managed through the API or Terraform [V]. One Access app per robot, with the owner's email as the rule, works mechanically.
- **At scale it does not work** [I]:
  - 500 applications per account caps a one-app-per-robot design at about 500 robots.
  - A single shared app with a growing email list stops at 1,000 emails per rule, and offers no per-robot isolation.
  - Cost is $7 per user per month above 50 users, about $210/month at 30 users on Pay-as-you-go and about $7,000/month at 1,000 users.
- **Fits as:** the prototype, or a small closed group of at most 50 people. It is not the answer for a 30–1,000 user community or a paid tier at 29 SEK/month.
- "Access for SaaS" is for putting Access in front of third-party SaaS apps, not a multi-tenant provider mode [V]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/.
- Cloudflare for SaaS plus Access: requires a Zero Trust plan, and "Access does not support wildcard custom hostnames in Cloudflare for SaaS" [V]: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/secure-with-access/. It does not solve the per-seat cost.

### 3.5 Recommended authentication without Access [I]
Because tunnel hostnames are public, something must authenticate requests. Cloudflare does not do it unless Access is used.
- The Worker control plane signs short-lived tokens (for example Ed25519 JWTs, with a scope for one robot ID and a short expiry).
- The robot holds the control plane's public key and checks the token on every REST call and on the WebSocket upgrade.
- Rate-limit unauthenticated requests on the robot, and use Cloudflare WAF rate rules if available on Free.

This keeps Access out of the cost path. The security responsibility moves to the robot software, which must fail closed. This is a design suggestion and not a Cloudflare feature.

---

## 4. Workers, D1, KV, Durable Objects

### 4.1 Workers [V]
Sources: https://developers.cloudflare.com/workers/platform/pricing/ (updated 2026-10-02) and https://developers.cloudflare.com/workers/platform/limits/ (updated 2026-10-29).

| | Free | Paid |
|---|---|---|
| Price | $0 | minimum $5/month per account |
| Requests | 100,000/day (resets 00:00 UTC, error 1027 after) | 10 M/month included, then $0.30 per M |
| CPU time | 10 ms per invocation | 30 M CPU-ms/month included, then $0.02 per M. Max 5 min per invocation (default 30 s) |
| Subrequests | 50 per request | 10,000 per request |
| Workers per account | 100 | 500 |
| Duration | n/a | "No charge or limit for duration" |
| Egress | no charge | "no additional charges for data transfer (egress) or throughput" |

- Time waiting on network calls (`fetch`, KV, DB) does not count toward CPU time [V].
- Workers Logs billing moves to Observability pricing on 2026-12-01 [V].
- Custom domain requirements [V]: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ requires an active Cloudflare zone, and "Custom Domains do not support wildcard DNS records". A custom domain cannot be created on a hostname that already has a CNAME. `workers.dev` as an alternative is not described on that page [U].

### 4.2 D1, KV and Durable Objects free and paid quotas [V]

| Product | Free | Paid |
|---|---|---|
| D1 rows read | 5 M/day | 25 B/month, then $0.001 per M |
| D1 rows written | 100,000/day | 50 M/month, then $1.00 per M |
| D1 storage / databases | 5 GB total, 10 DBs, 500 MB per DB | 5 GB then $0.75/GB-month, 10 GB per DB |
| KV reads / writes | 100,000/day, 1,000/day | 10 M/month, 1 M/month included |
| KV storage | 1 GB | 1 GB, then $0.50/GB-month |
| DO requests | 100,000/day | 1 M/month, then $0.15 per M |
| DO duration | 13,000 GB-s/day | 400,000 GB-s/month |

Sources: https://developers.cloudflare.com/d1/platform/pricing/, https://developers.cloudflare.com/d1/platform/limits/, https://developers.cloudflare.com/kv/platform/pricing/, https://developers.cloudflare.com/durable-objects/platform/pricing/ (D1/KV updated 2026-10-30).

- Durable Objects work on the Free plan with the SQLite backend only [V].
- Free-tier D1 and KV fail with errors once the daily quota is exhausted [V], so a limit hit means a control-plane outage until 00:00 UTC.
- Doc inconsistency on Durable Objects Free storage: pricing and limits pages say 5 GB, one section of the limits page says 1 GB [V, conflicting].
- D1 rejects query results above 50 MB from 2026-11-04 [V].
- Turnstile is free on the Free plan with unlimited challenges, 20 widgets per account [V]: https://developers.cloudflare.com/turnstile/plans/.

### 4.3 Can a Worker proxy WebSockets, and what is billed? (we want to avoid it)
- A WebSocket connection made to a Worker is billed as **one request** (the initial upgrade), and "WebSocket messages routed through a Worker do not count as requests" [V]: Workers pricing page, footnote.
- Worker duration is not charged on Standard [V].
- Per-message CPU for a proxied socket is not stated anywhere [U].
- Durable Objects differ [V]: incoming WebSocket messages are billed at a 20:1 ratio as requests, outgoing messages are free, and plain `accept()` incurs duration for as long as the socket is open. Hibernation avoids duration charges.
- **Conclusion** [I]: Worker proxying is possible and priced mildly, but the per-message CPU is undocumented, the Free plan CPU budget is only 10 ms, and a proxy adds a failure point and latency. Keeping app traffic on the tunnel path avoids it. This matches the requirement.

---

## 5. DNS, hostnames and certificates

### 5.1 Domain
- Cloudflare Registrar sells at cost: "You only pay what is charged by registries and ICANN" [V]: https://developers.cloudflare.com/registrar/. It supports 430+ TLDs.
- Cloudflare's plans page lists "Starting at $7.85" per year [V]: https://www.cloudflare.com/plans/network-cdn.md. That is the lowest starting price and not a per-TLD price.
- Per-TLD prices on Cloudflare's own site could not be retrieved (HTTP 403) [U]. Third-party guides give roughly $10–10.5/yr for `.com`, and $8–14 for `.dev`, `.app` and `.xyz` [S]. They disagree with each other, so check at purchase time.
- **Budget** [I]: about $10/yr, which is about 100 SEK/yr or about 8 SEK/month.

### 5.2 Hostname depth and Universal SSL [V]
Sources: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/ and https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/.
- Universal SSL "cover[s] your root domain ... and first-level subdomains". "Deeper subdomains — such as `dev.www.example.com` ... are **not** covered".
- Free plan certificates are ECDSA only. The record must be Proxied for Cloudflare to serve a certificate.
- So `robot123.example.com` is covered. **`robot123.connect.example.com` is not covered** on the Free plan.
- To cover deeper names you would need Advanced Certificate Manager at $10/month (price from the plans page, not stated per zone) [V/U]. A wildcard on ACM is also one level only.
- **Total TLS does not issue certificates for hostnames used with Cloudflare Tunnel** [V]: https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/. Deep tunnel hostnames would need manually ordered advanced certificates.
- **Recommendation** [I]: use `<robot-id>.example.com` (or `<robot-id>-connect.example.com`) and keep the control plane on `connect.example.com` or `api.example.com`. Do not use `<robot-id>.connect.example.com`.

### 5.3 Wildcards and per-robot records
- Customers on all plans can create and proxy wildcard DNS records [V]: https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/. DNS wildcards are multi-level, but certificates are not, as above.
- The tunnel docs describe one CNAME per hostname to `<UUID>.cfargotunnel.com`, and "create a CNAME entry for each hostname" [V]: https://developers.cloudflare.com/tunnel/routing/.
- Wildcard public hostnames and wildcard CNAMEs to a tunnel are **not documented** [U]. Do not depend on a single wildcard record pointing at many tunnels.
- Per-robot design [I]: create the CNAME for each robot in the pairing flow, which means one DNS API write per robot. At 1,000 robots that is 1,000 records, and the DNS record limit per Free zone was not found [U] and should be checked before scaling.
- The tunnel CNAME target only works inside the same Cloudflare account [V].

### 5.4 TryCloudflare quick tunnels [V]
Source: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/.
- "Quick Tunnels are for testing and development. For production, create a Cloudflare Tunnel."
- Up to 200 in-flight requests, additional ones return 429. No Server-Sent Events. "No uptime guarantee". The hostname changes each time.
- Acceptable for a very first smoke test, not for the prototype's pairing flow, since the hostname is random and nothing is stable.

---

## 6. Alternatives (prices as read on 2026-11-07)

| Option | Key facts | Fit for 30 robots |
|---|---|---|
| **ngrok** [V] https://ngrok.com/pricing, https://ngrok.com/docs/pricing-limits/ | Free: 3 online endpoints, 1 GB transfer, 20k requests, interstitial page, no custom domains, one auto-assigned dev domain. Hobbyist $10/month: 3 endpoints, 5 GB. Pay-as-you-go $20/month: $0.10 per GB beyond 5 GB, $1 per 100k requests beyond 100k, endpoints $0.02 per active hour, custom domain $0.01 per active hour. WebSocket and reselling terms not found [U]. | Poor. 30 always-on endpoints would be roughly $438/month from endpoint-hours alone (30 × 730 h × $0.02). Only workable if endpoints are active only while watching. |
| **Tailscale Funnel** [V] https://tailscale.com/pricing, https://tailscale.com/kb/1223/funnel | Personal plan free but "only suitable for non-commercial use", up to 6 users. Funnel: all plans, beta, ports 443/8443/10000, only `tailnet.ts.net` names (no custom domains), "non-configurable bandwidth limits" with no published numbers. Standard $8 per user per month. | Poor. Each robot would need to join your tailnet. That is not a multi-tenant model, and the 6-user cap and unpublished bandwidth limits rule it out. |
| **frp** on a VPS [V] https://github.com/fatedier/frp | Apache-2.0. v0.72.0 released 2026-11-04. HTTP vhost routing with `subDomainHost` is supported. End-user WebSocket support through the HTTP proxy is not documented (likely works as a byte copy [I]). The maintainer says development is in fragmented time, and v2 will not be compatible. | Good value, high ops burden. You own TLS, auth and uptime. |
| **rathole** [V] https://github.com/rapiz/rathole | Apache-2.0. TCP/UDP only, no HTTP host routing, last release v0.5.0 (2023-10-01). | Needs a separate TLS proxy for hostnames. Less suitable than frp. |
| **Hetzner VPS** [V] https://www.hetzner.com/cloud | CX23 (2 vCPU, 4 GB) €5.99/month excl. VAT, CAX11 €6.49/month excl. VAT. 20 TB traffic included in EU. Both showed "currently unavailable" at fetch time. Overage wording is ambiguous on the page [U]. | A frp/Pangolin host costs about €6–8/month, which is about 85 SEK/month including 25% Swedish VAT [I]. |
| **Oracle Always Free** | Page returned HTTP 403, nothing verified [U]. | Unknown. Do not rely on it without checking current terms. |
| **Pangolin** [V] https://pangolin.net/pricing, https://github.com/fosrl/pangolin | Dual licensed AGPL-3 and a commercial licence (free for personal use and for businesses under $100K gross annual revenue). Cloud Basic free: 5 sites, 5 users, 15 public resources. Team $4 per user per month. Self-host needs ports 80/443 TCP and 51820/21820 UDP. WebSocket support not verified [U]. | Good self-hosted option for a larger community, with built-in auth. Needs a VPS. The Cloud free tier is too small for 30 robots. |
| **zrok / OpenZiti** [V] https://zrok.io/pricing/ | zrok free: 5 GB per day, 50 share backends, 25 environments, interstitial removed by adding a card. Paid price not published ("Talk to NetFoundry"). Self-host is Apache 2.0, but the self-host guide URL returned 404 and WebSocket support is unverified [U]. OpenZiti is Apache 2.0, NetFoundry pricing not found [U]. | Possible but with little verifiable detail. Not the first choice. |
| **Fly.io** [V] https://fly.io/pricing | shared-cpu-1x 256 MB about $2.19/month, dedicated IPv4 $2/month, egress $0.02 per GB in EU/NA, no free tier. | You still need to build and run the tunnel server (frp or similar). Cost about $4–5/month plus egress. Not cheaper than Hetzner for what it gives. |

**Verdict** [I]:
- **Cheapest and least operational burden:** Cloudflare Tunnel with the design in section 7. The marginal cost is a domain.
- **Cheapest self-owned fallback:** a Hetzner VPS (about 85 SEK/month) running Pangolin or frp. It removes the dependence on Free-plan terms and the reselling question, but concentrates all traffic, auth and availability in one box you must secure and patch. 20 TB included traffic is far above the expected usage.
- **Not recommended:** ngrok and Tailscale Funnel for this use case.

---

## 7. Recommended Cloudflare design and cost estimates

### 7.1 Design [I]
1. Domain `example.com` on Cloudflare (DNS and Registrar).
2. Control plane: a Worker on `connect.example.com` (or `api.example.com`), with D1 for users, robots and pairings. Handles login, pairing and token issuing. No app traffic passes through it.
3. Pairing: the control plane creates a remotely-managed tunnel per robot (API), writes ingress and a proxied CNAME for `<robot-id>.example.com`, and delivers the tunnel token to the robot once.
4. Data path: browser to `<robot-id>.example.com` to Cloudflare to the robot's `cloudflared` to the local GUI. REST and WebSockets never touch the Worker.
5. Auth: the robot verifies short-lived signed tokens issued by the control plane. Access is used only for the single-user prototype if desired.
6. Heartbeat: client sends a ping every 20–30 s. The client reconnects automatically on close.
7. Cleanup: delete the tunnel and DNS record when a robot is unpaired, because inactive tunnels still count toward the limit.

### 7.2 Monthly cost in SEK (1 USD about 9.8 SEK [S])

| Scenario | Components | Estimate |
|---|---|---|
| (a) 1-robot prototype | Domain about $10/yr (about 8 SEK/month). Tunnel, Workers Free, D1 Free, Access Free (1 user): $0 | **about 8 SEK/month** (about 100 SEK/yr). Truly 0 SEK only if you use a quick tunnel with a random hostname and no SLA, which does not suit pairing. |
| (b) 30 robots | Domain about 8 SEK. 30 tunnels (of 1,000 free). Workers Free is ample: 100,000 requests/day for 30 users' control-plane calls. D1 Free is ample. No Access seats needed | **about 8 SEK/month.** Option: Workers Paid $5 (about 49 SEK) for headroom, giving about 57 SEK/month. Option: Access Free is also technically free for up to 50 users (see terms caveats), so it is not a cost driver. |
| (c) 1,000 robots | Domain about 8 SEK. 1,000 tunnels exactly at the included limit. Workers Paid $5 recommended (about 49 SEK) for safety against the daily cap. D1 Paid usage at this scale is negligible (included 25 B rows read and 50 M rows written per month) | **about 8–60 SEK/month** (about 57 SEK with Workers Paid). Any robots beyond 1,000 cost $4.50 each per month (about 44 SEK each). Using Access for 1,000 users would be about $7,000/month (about 68,600 SEK), so it is excluded. |

Cost notes:
- **Bandwidth:** no Cloudflare charge is documented for tunnel traffic [V/U: no cap or fee found], and Workers have no egress charge when used. At 10–200 KB/s only while someone is watching, it is a negligible volume.
- **Not included:** ACM at $10/month (about 98 SEK/month) is needed only if you insist on two-level hostnames, which this design avoids. VAT on the domain is not included.
- **Margin on the paid tier:** at 29 SEK per user per month and roughly 0.05 SEK per robot per month in Cloudflare costs at the 1,000 scale, infrastructure cost is not the issue. The terms question in section 1.4 is.
- **Account tunnel headroom:** you also need a few infrastructure tunnels, so plan for about 990 robots on the free allowance, or budget for Tunnels for Platforms from the start.

---

## 8. Open questions and unverified items

1. WebSocket idle timeout through proxied tunnel hostnames: not documented [U]. Test empirically with a 30 s ping.
2. Wildcard public hostname or wildcard CNAME to a tunnel: not documented [U]. Do not rely on it.
3. DNS record limit per Free zone: not found [U]. Check before provisioning 1,000 records.
4. Whether Tunnels for Platforms needs Enterprise: not stated [U]. The page describes a self-serve purchase.
5. Whether Free-plan terms permit a paid hosted tier where users' robots run through your tunnels: gray area [I]. Ask Cloudflare in writing. Section 1.4 lists the relevant clauses.
6. Whether OTP logins consume Access seats: likely yes, not stated [U].
7. Per-TLD Registrar prices: third-party only [S]. Oracle Always Free, zrok self-hosting, Pangolin and frp end-user WebSocket support, and ngrok WebSocket and ToS were not verified [U].
8. Exchange rates (USD about 9.8 SEK, EUR about 11 SEK) are approximate and the EUR rate is an assumption [U].

---

## 9. Sources

Cloudflare official (all read 2026-11-07):
- Tunnel overview: https://developers.cloudflare.com/tunnel/
- Tunnel get started / API: https://developers.cloudflare.com/tunnel/setup/
- Tunnel routing: https://developers.cloudflare.com/tunnel/routing/
- Quick tunnels: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
- Tunnels for Platforms: https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/
- Account limits: https://developers.cloudflare.com/cloudflare-one/account-limits/
- API rate limits: https://developers.cloudflare.com/fundamentals/api/reference/limits/
- WebSockets: https://developers.cloudflare.com/network/websockets/
- Connection limits: https://developers.cloudflare.com/fundamentals/reference/connection-limits/
- Upload limits: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
- Application Services terms: https://www.cloudflare.com/service-specific-terms-application-services/
- Zero Trust terms: https://www.cloudflare.com/service-specific-terms-zero-trust-services/
- Self-Serve Subscription Agreement: https://www.cloudflare.com/terms/
- Terms-of-service blog post: https://blog.cloudflare.com/updated-tos/
- Zero Trust plans: https://www.cloudflare.com/plans/sase-zero-trust.md
- Network and CDN plans: https://www.cloudflare.com/plans/network-cdn.md
- Seat management: https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/
- One-time PIN: https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/
- Identity providers: https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/
- Self-hosted apps: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Access policies: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
- JWT validation: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- Access sessions: https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
- Access for SaaS apps: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/saas-apps/
- Cloudflare for SaaS with Access: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/secure-with-access/
- Cloudflare for SaaS plans: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers custom domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- KV pricing: https://developers.cloudflare.com/kv/platform/pricing/
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Turnstile plans: https://developers.cloudflare.com/turnstile/plans/
- Universal SSL: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/
- Universal SSL limitations: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
- Advanced Certificate Manager: https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/
- Total TLS: https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/
- Wildcard DNS: https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/
- Registrar: https://developers.cloudflare.com/registrar/

Alternatives (vendor pages):
- ngrok: https://ngrok.com/pricing and https://ngrok.com/docs/pricing-limits/
- Tailscale: https://tailscale.com/pricing and https://tailscale.com/kb/1223/funnel
- Hetzner Cloud: https://www.hetzner.com/cloud
- Fly.io: https://fly.io/pricing
- frp: https://github.com/fatedier/frp
- rathole: https://github.com/rapiz/rathole
- Pangolin: https://pangolin.net/pricing and https://github.com/fosrl/pangolin
- zrok: https://zrok.io/pricing/
- OpenZiti: https://github.com/openziti/ziti

Secondary (exchange rate and domain prices only): converter and forecast pages such as https://30rates.com/usd-to-sek-today-forecast-dollar-krona, and registrar comparison guides such as https://costgoat.com/compare/domains/dev and https://dev.to/devtoolpicks/best-domain-registrars-for-indie-hackers-in-2026-cloudflare-vs-porkbun-vs-namecheap-2ebm.
