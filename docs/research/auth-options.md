# Mowgli Connect: login options (GitHub OAuth, Google OIDC, Clerk, Cloudflare Access)

Research date: 2026-11-08. Tags: **[V]** = read on an official page today, **[U]** = UNVERIFIED (third-party, conflicting, partial, or not found), **[I]** = my inference.
Method: web research only. Official pages were fetched through a summarising fetch tool, so wording is paraphrased, not verbatim, unless quoted. Nothing was tested against a live account.
Project context read from the repo: the relay already does GitHub OAuth with PKCE, a hashed single-use `state` in D1, an HttpOnly session cookie, and an owner allowlist (`ALLOWED_GITHUB_LOGINS`, preferably `gh:<numeric id>`) (`relay/README.md`). The prototype runs on `*.workers.dev` with 0 kr and no domain (`README.md`, `docs/architecture.md`). A named setup needs a domain (about 100 kr/year, or a free eu.org / DigitalPlat domain) (`README.md`, `docs/research/free-hostnames.md`).

## 0. Summary table

| | (a) GitHub OAuth only | (b) Google OIDC in the Worker | (c) Clerk | (d) Cloudflare Access (and others) |
|---|---|---|---|---|
| Cost at ~30 users | 0 kr | 0 kr | 0 kr on Hobby (50,000 MRU free) [V] | 0 kr up to 50 users [V/U], then $7/user/month [V in `cloudflare-pricing-limits.md`] |
| Needs a domain? | No (works on `*.workers.dev`) | No (redirect URI can be a `workers.dev` URL) [I] | **Yes for production** (own domain, DNS records, own Google/GitHub OAuth credentials) [V] | Only for a custom hostname; Access can also protect `workers.dev` [V] |
| Who can sign in | People with a GitHub account. Many mower owners do not have one [I] | Anyone with a Google account (most people, including non-developers) [I] | Whatever you enable: Google, GitHub (max 3 social connections on Hobby), email code on some plans [V/U] | Allowlisted emails via one-time PIN or an IdP [V] |
| Verification / review | None | None for `openid email profile` in Testing; in production, verification is needed only for sensitive or restricted scopes or for name/logo [V]. Residual uncertainty, see section 2 | Clerk production requires you to create your own Google OAuth app anyway [V], so the same Google rules apply | None |
| Integration effort in the Worker | Done | Small: about one more provider in `oauth.ts` (about 100-150 lines) [I] | Medium: SDK or JWKS verification, handshake or Account Portal redirect, DNS, new user model [I] | Small to verify the JWT; poor fit for self-service multi-tenant signup [I] |
| Login depends on a third party at runtime | GitHub only | Google only | Clerk **and** the underlying IdP; Clerk had several full outages in 2025-2026 [V] | Cloudflare (already a dependency) |
| Data stored at vendor | Nothing beyond GitHub's own | Nothing beyond Google's own | User records stored at Clerk, a US company [V] | Seat records at Cloudflare |
| Lock-in | None | None | Moderate (user ids, sessions, production domain wired to Clerk) | Low-moderate; Zero Trust terms forbid reselling [V] |

**Recommendation in one line:** keep GitHub for the prototype. When non-developers join, add Google OIDC directly in the Worker (keep GitHub). Treat Clerk as an option only if you later need email/password, email-code or passkey login. It does not make the free setup easier.

## 1. (a) Keep GitHub OAuth only

- Cost: GitHub OAuth apps have no stated usage charge or user cap in the docs I read, but the page I fetched did not address limits or pricing, so "no cap" is not confirmed [U]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app
- GitHub's own guidance: do not use email as a user identifier, store the numeric `id` from `GET /user` (same page). The relay already allowlists `gh:<id>` [V, repo].
- Effort: zero, already built and tested (`docs/test-report.md` lists real GitHub login as not yet tested live).
- Weakness for this audience: robot owners who are not developers often have no GitHub account [I, no source; consistent with the stated user base]. That is the only real argument against it.

## 2. (b) Google OAuth / OpenID Connect directly in the Worker

### Integration
Google's documented server flow maps one-to-one onto the existing GitHub code [V]: https://developers.google.com/identity/openid-connect/openid-connect
- Discovery: `https://accounts.google.com/.well-known/openid-configuration`. Authorization endpoint `https://accounts.google.com/o/oauth2/v2/auth`, token endpoint `https://oauth2.googleapis.com/token`, JWKS from `jwks_uri` (`https://www.googleapis.com/oauth2/v3/certs`).
- Flow: random `state` plus `nonce`, `response_type=code`, `scope=openid email`, exchange the code with the client secret, read `id_token`.
- Validation: check `iss` (`https://accounts.google.com` or `accounts.google.com`), `aud` = your client id, `exp`, `nonce`. Google says signature checking is optional when the token comes straight from the token endpoint over TLS, but you can verify against the JWKS (the Worker can do this with WebCrypto).
- Identity: use `sub` as the stable id, never `email`; check `email_verified` before trusting the email; `hd` is only a UI hint. Same rule as GitHub (use the numeric id).
- PKCE: the discovery document advertises `S256`; the page does not describe how to send it. The relay's existing PKCE code can be reused, and Google's PKCE support for web clients is documented elsewhere [U for exact parameters here].
- Consequence for the data model: users become `google:<sub>` next to `gh:<id>`. Allowlist/ownership code needs a provider prefix. Account linking between a person's GitHub and Google identities is your problem (an owner could pair a robot under one and later log in with the other). [I]

### Cost
Free. Needs a Google Cloud project with an OAuth client and a consent screen (Branding page) [V, same Google page]. No pricing for basic sign-in was found on the pages read; Google Identity sign-in is not metered in any source I saw [U].

### App verification and user caps (the question asked)
Sources: https://support.google.com/cloud/answer/15549945 (publishing status / audience), https://support.google.com/cloud/answer/13463073 and https://support.google.com/cloud/answer/10311615 (verification and branding).
- Publishing status "Testing": limited to 100 test users listed on the consent screen; authorizations expire after 7 days. **Exception stated by Google:** if the app requests only `email`, `profile` and `openid` (or OIDC equivalents), test users need not be listed, see no warning, and authorizations do not expire after 7 days [V].
- Publishing status "In production": any Google Account holder can authorize after you click "Publish app" [V].
- Verification is required for apps requesting **sensitive or restricted** scopes [V]. Apps using only non-sensitive scopes: verification is optional [V]. The Google scopes page labels `openid`, `userinfo.email` and `userinfo.profile` as the basic sign-in scopes but the table I read does not itself say "non-sensitive" [U for that exact classification]: https://developers.google.com/identity/protocols/oauth2/scopes. The Testing exception above, which names exactly these three scopes, is the strongest evidence that they are the baseline set.
- The 100-new-user lifetime cap applies to apps that show the **unverified app screen**, which is triggered by sensitive/restricted scopes requested before verification [V]. It cannot be reset [V]. With only the three basic scopes it should not apply [I].
- Without verification, the consent screen shows only your app domain, not your app name or logo; name and logo need (lighter) brand verification, which requires a verified domain, a homepage that represents the app, and a privacy policy [V]: https://support.google.com/cloud/answer/13463073 and https://support.google.com/cloud/answer/10311615
- **UNVERIFIED residual risk:** a 2019 Google Groups thread reports an "unverified app" screen even with only these scopes, and a third-party guide says an In-production unverified app shows "Google hasn't verified this app" to external users (https://developer.nylas.com/docs/cookbook/use-cases/build/fix-google-access-denied/, https://groups.google.com/g/google-appengine/c/UYNGG--Q0cM/m/Oev_IIZQDgAJ). I could not confirm either as current behavior. Test with a non-organization Google account after publishing before relying on this. Also note: Clerk's Google guide says moving to production "requires Google's verification review" (https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google), which is broader than Google's own pages; I would trust Google's pages, but this is another reason to test.
- Practical for ~30 users: even if the worst case applies, 30 users is under 100 in Testing mode, and the three-scope exception means no 7-day expiry. Publishing ("In production") is still the better state. [I]

### Outage and privacy
- Outage: Google sign-in availability; no extra vendor beyond Google. Because the Worker mints its own session after login, an IdP outage only blocks new logins, not existing sessions [I, from the existing design].
- Privacy: no third-party store; you keep email/`sub` in D1 only.

### Effort
Small, roughly a day including tests [I]. Largest risk is the account-linking and allowlist data model, not the OIDC flow.

## 3. (c) Clerk

### Free plan (called "Hobby") [V]: https://clerk.com/pricing
- 50,000 monthly retained users (MRU) per app; exceeding it requires Pro with a one-month grace period. Free allowance raised from 10,000 to 50,000 MRU on 2026-02-05 per Clerk's own article (https://clerk.com/articles/clerk-pricing-explained); older third-party pages still say 10,000 and are stale.
- MRU definition: a user who returns at least one day (24h+) after signing up. A user who signs up and never returns does not count. [V, pricing page]
- Included: unlimited apps, 3 dashboard seats, **up to 3 social connections**, custom domain, basic protection (brute-force prevention).
- Not on Hobby: MFA, passkeys, satellite domains, custom session duration, SMS codes, Clerk branding removal, SSO connections. Session lifetime fixed at 7 days. Log retention 1 day.
- Pro: $25/month ($20 annual), then $0.02 per MRU for 50,001-100,000.
- The Dashboard tags paid features and the FAQ says Pro features can be tried in development; deploying them to production requires Pro [V, pricing page FAQ; https://clerk.com/docs/guides/development/managing-environments]. Google/GitHub login and email codes are not listed as paid, so a Google+GitHub setup should stay on Hobby [I]. Whether email-code and email/password sign-in are free is not stated on the pricing page I read [U].
- Third-party pricing aggregators disagree on tiers; I ignored them.

### Development instance [V]: https://clerk.com/docs/guides/development/managing-environments
- Capped at **100 users**, and user data cannot be transferred to production. (A search snippet of another docs version said 500; the current managing-environments page says 100. Treat 100 as current.)
- A "Development" banner appears in the Clerk **Dashboard**. I found no evidence of a banner inside the end-user sign-in UI [U]. The Account Portal uses an `accounts.dev` domain. Development uses a `__clerk_db_jwt` query parameter instead of cookies, with looser security, "not suitable for production" (search result summary of the same docs).
- Dev instances use Clerk's shared Google/GitHub OAuth credentials, so the Google consent screen shows Clerk's dev setup, not your app [V, https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google, plus dev domain note]. Fine for the owner testing, not for real users.

### Production instance requirements [V]: https://clerk.com/docs/guides/development/deployment/production
- A domain you own. The page mentions no `*.workers.dev` or other platform subdomain option [V that it is silent; so assume not supported, I]. This breaks the "0 kr, no domain" prototype property; a domain is about 100 kr/year, or a free-domain option from `free-hostnames.md`.
- DNS records from the Clerk Dashboard "Domains" page (a CNAME for the Frontend API plus others for sessions and email sending; exact hostnames are not on the docs page I read [U]). Must be "DNS only" (not proxied) if on Cloudflare; propagation up to 48 hours; CAA records must not block Let's Encrypt or Google Trust Services.
- Your own OAuth credentials for each social provider: "Shared development credentials are not secure for production" [V]. So for Google you must still create the Google Cloud OAuth client, with the same consent-screen/publishing rules as section 2, and enter its id/secret in Clerk. Clerk does not remove the Google setup.
- Different live keys (`pk_live_`, `sk_live_`), set `authorizedParties`, restrict subdomains via an allowlist.

### Integration in a Cloudflare Worker (no framework)
- Verification: `authenticateRequest()` from `@clerk/backend` accepts a standard `Request`, requires `publishableKey` plus `secretKey` or `jwtKey`, and with `jwtKey` (PEM public key from the Dashboard) verifies **without a network call** [V]: https://clerk.com/docs/reference/backend/authenticate-request. Always set `authorizedParties`.
- Manual alternative: verify the RS256 JWT yourself using the JWKS at `https://api.clerk.com/v1/jwks` or `<frontend-api>/.well-known/jwks.json`; check `exp`, `nbf`, and `azp` [V]: https://clerk.com/docs/guides/sessions/manual-jwt-verification. The cookie is `__session` for same-origin requests; for cross-origin use the `Authorization` header (same page).
- Workers compatibility of `@clerk/backend`: described as built for V8 isolates (third-party package listing); a Hono middleware exists. **I found no official Clerk guide for Workers** [U]: https://jsr.io/@hono/clerk-auth/doc
- Statuses returned: `signed-in`, `signed-out`, `handshake` (the SDK may require you to return a redirect to Clerk for the handshake) [V]. Handling `handshake` correctly in a plain Worker is the fiddly part [I]; the docs I read did not cover it [U].
- Login UI: either hosted **Account Portal** (Clerk-hosted sign-in/sign-up/profile pages; web apps link to them; redirect back with auth context; customization limited to Dashboard options) [V]: https://clerk.com/docs/guides/account-portal/overview, or `@clerk/clerk-js` in a plain page (`mountSignIn`) [V]: https://clerk.com/docs/js-frontend/getting-started/quickstart. The docs I read do not say how Account Portal works with a plain Worker [U].
- Lowest-coupling pattern for this project [I]: use Clerk only for the login step. After sign-in, the Worker verifies the Clerk JWT once (JWKS or `jwtKey`), reads the user id, then mints the existing own session cookie and Ed25519 grants. Day-to-day grant minting then does not call Clerk. Keep `provider:id` and verified email in D1 next to the Clerk id.

### Outage and lock-in
- Clerk published post-mortems for full or major outages on 2025-02-06, 2025-06-26 (about 45 minutes, a Google Cloud Run failure), 2025-09-14/18 (database), 2026-02-10 (DNS provider), 2026-02-19 (database query plan) and 2026-03-10 (Cloud SQL migration affecting session tokens) [V for 06-26 and 02-19 via https://clerk.com/blog/postmortem-jun-26-2025-service-outage and https://clerk.com/blog/2026-02-19-system-outage-postmortem; the others come from search-result summaries, [U]]. Roughly five or six major incidents in 13 months.
- With `jwtKey` networkless verification the Worker keeps working during a Clerk outage for already-issued tokens, but tokens are short-lived (lifetime configurable; 60 s is commonly cited but not confirmed on the pages I read [U]) and new sign-ins fail. Networkless verification also cannot see revocation until `exp` (summary of Clerk reference, [V] for the networkless claim, revocation point from a Rust crate's docs [U]).
- With the "own session after login" pattern above, an outage blocks only new logins [I].
- Lock-in: Clerk user ids (`user_...`) and the production domain's DNS records are wired to Clerk; user data cannot be moved from development to production [V]. Password hashes can be exported by Clerk on request [U, not checked]. Mitigated by storing the provider id and email yourself.

### Privacy
- Clerk is a US company; its DPA lets it store and process data in any location where it or sub-processors have facilities, with a sub-processor list and 15 days' change notice [V]: https://clerk.com/legal/dpa. It is certified under the EU-US, UK extension and Swiss-US Data Privacy Frameworks (notice dated 2024-02-22) [V]: https://clerk.com/legal/dpf. Its GDPR notice says data supplied via the website goes directly to the USA [V]: https://clerk.com/legal/gdpr.md. I did not check the current sub-processor list [U] (https://clerk.com/legal/subprocessors).
- For a Danish/EU hobby service with owners' emails and names, this adds a processor to disclose in a privacy notice [I]. Using Google/GitHub directly adds none beyond the IdP the user already chose.

### Effort
Highest of the options: buy or borrow a domain and add Clerk DNS records, create the Google (and GitHub) OAuth apps for production anyway, rewrite login routes, handle handshake, update the user table and allowlist [I]. A Hobby plan keeps cost at 0 kr except the domain.

## 4. (d) Cloudflare Access and other free options (brief)

- **Cloudflare Access / Zero Trust:** free for up to 50 users, then $7/user/month, with seats held until removed [V in the repo notes citing Cloudflare seat docs; third-party pricing trackers agree [U for the exact free-plan feature set]]. Access can protect a `workers.dev` URL [V]: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/. It sends one-time-PIN emails (10 minute expiry, single use, only to emails allowed by a policy) [V]: https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/. A Worker validates `Cf-Access-Jwt-Assertion` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` with `iss` and `aud` checks [V]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/. Poor fit: it is an allowlist gate, not self-service signup; each owner would have to be added to a policy; the free tier is a hard cap at 50 users; and the Zero Trust service terms prohibit reselling to third parties (section 2.2, per `docs/research/cloudflare-pricing-limits.md`, https://www.cloudflare.com/service-specific-terms-zero-trust-services/). Not recommended.
- **Email one-time code (own implementation):** the only way to serve people with neither GitHub nor Google. Needs an email-sending service, which is outside this research and was not priced here [U].
- **WorkOS AuthKit:** free up to 1M MAU, but a custom domain for AuthKit is a flat $99/month [V per WorkOS pricing page snippet: https://workos.com/pricing]. Not 0 kr in production if you want your own domain; skip.
- **Auth0 / Supabase Auth / Firebase Auth:** not researched here [U]. They share Clerk's main costs: a third-party dependency, data stored at a vendor, and a user-model migration, so they would not change the conclusion.

## 5. Recommendation

### (1) Prototype now: keep GitHub OAuth only
- Already implemented, 0 kr, no domain, no vendor, no third-party review. Prototype owners are the developers around Bruno who have GitHub accounts [I].
- Do not adopt Clerk for the prototype: production needs a domain and DNS records, your own Google/GitHub credentials, and a dev instance is limited to 100 users with `accounts.dev` and not meant for production [V]. That is more work and more cost than the problem it solves.
- Optional cheap hedge: abstract the provider in `oauth.ts` (`provider`, `provider_user_id`, verified email) and make the allowlist key `provider:id`, so Google can be added without migration.

### (2) Later, when non-developers join: add Google OIDC in the Worker, keep GitHub
- Covers nearly everyone with a smartphone, costs 0 kr, adds no vendor, keeps the owner-mints-own-session design, and keeps working on `*.workers.dev`.
- Do: create a Google Cloud OAuth client, set the consent screen to External, request only `openid email` (`profile` optional), publish to production, test with an outside Google account (see section 2 residual risk), use `sub` as the id and require `email_verified`.
- Consider Clerk only if you find that a meaningful group of owners has neither Google nor GitHub, or if you want email codes/passwords/passkeys without building them. At that point the domain cost is likely already paid for named tunnels, and Hobby is free for 50,000 MRU. Use the "login only, then mint own session" pattern so a Clerk outage cannot take down existing sessions or grant minting.
- Do not use Cloudflare Access for user login: 50-user hard cap, no self-service, and the service-terms resale restriction.

## 6. Open items (UNVERIFIED)
1. Whether Google shows an "unverified app" screen to external users for an In-production app with only the three basic scopes (Google's pages say no verification is needed; some third-party reports disagree). Needs a live test.
2. Exact Clerk DNS record names and whether a subdomain can be the production domain.
3. Clerk handshake behavior and Account Portal flow in a framework-less Worker; no official Workers guide found.
4. Clerk session token default lifetime (60 s commonly cited, not confirmed here); whether email-code sign-in is free on Hobby.
5. Whether a Cloudflare Zero Trust free plan requires a payment method; whether OTP logins count as seats.
