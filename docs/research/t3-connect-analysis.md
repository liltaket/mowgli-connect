# T3 Connect implementation analysis for Mowgli Connect

Research date: 2026-11-07. Scope: the checked-out T3 Code implementation in a local `t3code` checkout; this report describes code and repository docs, not a live Cloudflare account. Source references use `path:line` in that checkout.

## Executive summary

T3 Connect is a control-plane broker, not an HTTP/WebSocket proxy. It provisions one Cloudflare Tunnel hostname per account/environment allocation, gives the host a Cloudflare connector token, and tells the client the hostname. The client then contacts the robot/environment directly over the proxied tunnel. Clerk authenticates cloud users to the relay; the relay mints an environment-specific bootstrap credential through a signed, DPoP-bound exchange; the environment converts that one-time credential into its own session. The environment then validates requests locally, without asking the relay on every request (`docs/internals/t3-connect.md:3-6,44-65`; `docs/internals/environment-auth.md:3-6`).

For Mowgli Connect, the most reusable ideas are: outbound-only `cloudflared`; one stable, account-scoped endpoint per robot; strict account-to-robot link records; short-lived signed bootstrap grants bound to a client key; local robot-side session auth; origin restriction to loopback; and no app traffic through the control plane. T3’s PlanetScale/Hyperdrive setup, multi-provider identity, account plan handling, replay-proof database, elaborate recovery/reaping, observability, mobile notification infrastructure, and generic environment scopes are not needed initially.

## 1. Per-environment tunnel provisioning

### Cloudflare resources and routing

- The relay uses Cloudflare’s managed Tunnel API through Alchemy’s `Cloudflare.Tunnel.ReadWriteTunnel()` binding, plus the DNS API through `Cloudflare.DNS.ReadWriteDns(zone)` (`infra/relay/src/worker.ts:185-189,565-566`). The provider wraps the tunnel client operations `list`, `create`, `putConfiguration`, `getConfiguration`, `getToken`, and `delete` (`infra/relay/src/environments/ManagedEndpointProvider.ts:239-284,1579-1667`).
- Provisioning finds an undeleted named tunnel or creates one with `{ name, configSrc: "cloudflare" }` (`ManagedEndpointProvider.ts:1279-1299`). It writes a remote ingress rule for the single allocated hostname to the host’s validated loopback HTTP origin, followed by a catch-all `http_status:404` rule (`ManagedEndpointProvider.ts:1347-1405`).
- DNS is a proxied CNAME from the managed hostname to `<tunnel-id>.cfargotunnel.com`, TTL 1 (`ManagedEndpointProvider.ts:1408-1414`). Hostnames use a stage label plus a 16-hex stable suffix under the configured tunnel DNS zone; tunnel names use `t3-<stage>-<suffix>` (prefix constant) (`deploymentConfig.ts:93-123`; `infra/relay/README.md:107-111`). The suffix derives from the stage, cloud user ID, and environment ID rather than public environment ID alone (`deploymentConfig.ts:85-90,125-132`).
- This is the standard Cloudflare Tunnel management and DNS API abstraction, not Cloudflare Access. The code is not provisioning a Cloudflare for SaaS custom hostname per user, nor a “Tunnels for Platforms” product abstraction: each environment gets its own ordinary managed tunnel, a DNS CNAME, and a connector token. Cloudflare terminates public TLS and routes to the tunnel connector; app authorization remains at the environment.

### Token delivery and `cloudflared`

- After tunnel/DNS setup, the relay calls `getToken(tunnel.id)` and returns it in `endpointRuntime.connectorToken` with tunnel ID/name (`ManagedEndpointProvider.ts:1513-1572`). The authenticated host receives this in the link response and saves runtime config in its local secret/config store (`infra/relay/src/http/Api.ts:850-867`; `apps/server/src/cloud/CloudLink.ts:877-902`). It is a tunnel connector credential, not a client login token.
- Host runs pinned `cloudflared tunnel --no-autoupdate --loglevel info --output default --metrics 127.0.0.1:0 [--protocol http2] run` with `TUNNEL_TOKEN` in the child process environment (`apps/server/src/cloud/ManagedEndpointRuntime.ts:727-755`). Default transport is automatic; `--protocol http2` is added only for configured fallback. The metrics listener is loopback-only and used for connector health/config checks (`ManagedEndpointRuntime.ts:119-129,515,883-890`). Release pin is `CLOUDFLARED_VERSION = 2026.10.4`, minimum supported is `2025.6.1`; binaries are pinned with URLs and checksums (`packages/shared/src/relayClient.ts:31-34`; docs `docs/internals/t3-connect.md:157-180`). An explicit user binary is respected (`t3-connect.md:167-168`).

### Limits, retention, cleanup

- Default account cap is 3 tunnels. Paid linked T3 Chat raises it to 10 (Pro) or 100 (Premier). An operator override replaces both defaults. An environment that already occupies a slot can restart/relink without rechecking the plan; provisioning reserves capacity under a per-user DB advisory lock (`packages/contracts/src/relay.ts:966-972`; `ManagedTunnelLimits.ts:151-217`). In-progress allocations count for 15 minutes to avoid leaked reservations (`ManagedTunnelLimits.ts:19-20`).
- Ordinary CLI-managed shutdown releases/deletes its live tunnel to avoid the paid idle resource, but preserves its hostname reservation and allocation. Client-installed links and update handoffs retain the tunnel (`docs/internals/t3-connect.md:81-92`). Unlink removes authorization before best-effort external teardown; captured allocation generation prevents stale cleanup deleting a tunnel reused by relink/restart (`t3-connect.md:94-99`).
- A five-minute cron can reap eligible inactive tunnels, default mode `off` and configurable `dry-run`/`enabled`. A Cloudflare-reported down tunnel must be down at least 5 minutes; never-connected tunnels get an hour to allow pairing. Reaping only deletes allocations with recovery registration; rows missing tunnel IDs, mismatched IDs, or absent allocation rows are skipped. Sweep limits include at most 10 list requests, up to 100 deletes and a 2-minute cron deadline (the implementation also budgets 90s for deletes, concurrency 8); Cloudflare rate limits stop deletes (`docs/internals/t3-connect.md:101-140`; `ManagedEndpointReaper.ts:20-28,64-90,152-179,330-377`).
- A host registers recovery with a short-lived environment-key signature over tunnel ID and loopback origin. If the tunnel is reaped, it can request replacement on the same allocation/hostname. Hosts without recovery support are not reaped (`t3-connect.md:112-140`). This is robust paid-tunnel lifecycle engineering for laptops that sleep; not needed for an initial handful of always-on robots.

## 2. Linking / pairing and what the relay stores

T3’s “pairing” here is not a numeric one-time user code. The host signs into a Clerk account, requests a relay-signed link challenge, then signs a proof with its persistent environment key. The account owner’s authenticated cloud identity authorizes the link.

1. The signed-in host calls `POST /v1/client/environment-link-challenges` with requested tunnel/notification capabilities. Relay returns a signed `t3-link-challenge+jwt` bound to Clerk user (`sub`), relay issuer/audience, random `jti`, expiry and requested booleans. Challenge lifetime is five minutes (`infra/relay/src/http/Api.ts:929-946`; `infra/relay/src/auth/RelayTokens.ts:21-37,113-129`).
2. Host checks that its claimed origin is an allowed origin and signs a link proof with its environment signing key. It binds challenge, environment ID, descriptor, environment public key, origin, endpoint, capabilities, issuer `t3-env:<environmentId>`, audience relay issuer and a unique `jti`. Link proof lifetime is five minutes (`apps/server/src/cloud/CloudLink.ts:579-615`).
3. Relay verifies the proof with the included environment public key; requires matching subject/environment/descriptor and capabilities; checks the relay-issued challenge belongs to the authenticated cloud user and authorizes requested capabilities; atomically consumes both proof nonce and challenge nonce; rejects non-loopback managed-tunnel origins; then provisions tunnel, persists link, and returns a relay environment credential and relay public mint key (`EnvironmentLinker.ts:149-245,255-289,308-335`; `Api.ts:850-867`).
4. Environment public key establishes host identity; Clerk user ID establishes cloud account. Each account/environment pair gets a distinct row and distinct endpoint allocation. The relay credential is generated as `t3env_<credentialId>_<secret>`; only its SHA-256 hash is stored. Credential lookup also requires a matching active link for that environment/public key (`EnvironmentCredentials.ts:89-103,107-178,181-242`).

Relay stores link owner/user ID, environment ID/label, environment public key, endpoint URLs/provider, capabilities/preferences, device association, revocation state and timestamps (`infra/relay/src/persistence/schema.ts:65-88`). The allocation row stores hostname, tunnel ID/name, DNS record ID, origin, generation, recovery public key/status and release timestamps (`schema.ts:90-113`). It stores a hash—not plaintext—of its environment credential (`schema.ts:129-148`). The client receives the connector token and the host persists it locally. The relay does not persist browser/environment session tokens (`docs/internals/t3-connect.md:44-58`).

Unlinking requires authenticated ownership; the relay revokes the link and environment credential, then tears down resources. Failed Cloudflare teardown keeps state to retry, but the authorization revocation is already committed (`EnvironmentLinker.ts:291-335`; `docs/internals/t3-connect.md:94-99`).

## 3. Authentication at the tunnel endpoint

### Cloud identity and relay authorization

- Browser/native app first authenticates to Clerk. Relay accepts Clerk session JWTs with expected audience and also CLI OAuth bearer tokens; the setup configures a `t3-relay` JWT template with audience `t3-code-relay` (`docs/operations/connect-setup.md:37-61`; `infra/relay/src/http/Api.ts:1664-1727`). T3 has no Cloudflare Access policy in front of the tunnel. It uses its own app/relay authentication.
- Client creates a DPoP key and exchanges its Clerk subject token at relay for a signed JWT, header type `t3-relay-dpop-access+jwt`, containing relay `iss`/`aud`, user `sub`, `jti`, `iat`, `exp`, client ID, allowed `scope`, and `cnf.jkt` thumbprint. TTL is 30 minutes; web/mobile scopes are explicitly allowlisted (`RelayTokens.ts:21-24,40-65,157-203`; exchange in `Api.ts:1037-1083`).
- DPoP proof signs each relay request and binds HTTP method, URL, key thumbprint and the relay access token. Relay checks and records `(thumbprint,jti)` for replay prevention in the DB; expiry pruning runs in cron (`DpopProofs.ts:49-68,103-155,157-173`; `worker.ts:480-504`).
- To connect, client presents the DPoP relay token to relay. The relay checks scope and key, checks an active user/environment link, and signs a one-off cloud mint request addressed to `t3-env:<id>`. It includes user/environment, requested connect scope, client DPoP thumbprint, nonce, `jti`, `iat`, and `exp`; two-minute lifetime (`Api.ts:1095-1115`; `EnvironmentConnector.ts:598-635`).

### Environment-side mint and local session

- Host’s `/connect` handler verifies the relay mint JWT against the relay public key configured at link time, exact environment audience, currently linked cloud user, environment ID, bounded lifetime, exact `environment:connect` scope, and matching confirmation thumbprint. It consumes both `jti` and nonce to prevent replay, then creates a local one-time pairing/bootstrap credential with standard environment scopes, a two-minute lifetime, and the client proof-key thumbprint (`apps/server/src/cloud/CloudLink.ts:1517-1587`).
- Host signs its mint response using its environment key. Response is bound to relay issuer, environment identity, request nonce and client proof key; relay verifies the signature and these bindings before returning the credential (`CloudLink.ts:1588-1615`; `EnvironmentConnector.ts:197-229,680-699`; architecture note `docs/internals/t3-connect.md:53-65`). Thus a malicious service answering at the tunnel origin cannot impersonate the linked host without its environment signing key.
- Client exchanges the one-time credential directly with the environment for a local DPoP access token. It is a local signed session token, scoped by the bootstrap grant and bound to that same DPoP public key; the documented connect-issued DPoP session TTL is one hour (`apps/server/src/auth/EnvironmentAuth.ts:956-1010`; `apps/server/src/auth/SessionStore.ts:643-667,740-748`). Session verification, scopes, expiry and revocation are enforced by the environment; requests do not call the relay (`docs/internals/environment-auth.md:3-6,25-28`).
- Relay-issued tokens and local environment session tokens have separate audiences and purposes. A relay access token is never accepted as an environment login (`environment-auth.md:3-6`). No Cloudflare Access login is used.

### Revocation semantics

- Unlink revokes future relay connections and the stored host credential; connector credential/tunnel cleanup is external and can fail/retry. A relay DPoP JWT is stateless and has a 30-minute lifetime; the inspected implementation has no per-token revocation list for those access JWTs. A still-valid relay token must still pass active-link authorization on connect. Existing environment sessions are managed locally; unlink alone is not shown to synchronously revoke every already-issued local session. Local session revocation/expiry closes sessions/sockets via the server’s session store (`environment-auth.md:73-87`; `t3-connect.md:94-99`).
- Tunnel credentials are invalidated when their Cloudflare tunnel is deleted/released. Routine shutdown has special retention cases to preserve reconnection behavior (`t3-connect.md:81-92`).

## 4. WebSocket authentication through the tunnel

Normal socket traffic goes directly over `wss://<robot-host>/ws`; the relay is not in this handshake. T3 does not put its long-lived environment access token in the WebSocket URL. Client first makes an authenticated HTTP request to mint a short-lived, route-specific WebSocket ticket. Ticket claims name session ID, expiry, optional audience (`rpc`, media routes), and optional client key thumbprint; ticket is signed locally (`apps/server/src/auth/EnvironmentAuth.ts:1213-1237`; `SessionStore.ts:851-887`).

At upgrade, client passes `wsTicket` in the query string. A DPoP-bound RPC ticket also needs a fresh proof in the `dpop` query parameter (or header where supported); proof covers the ticket and handshake URL/method and is single-use. Ticket must match the requested socket audience. The short ticket avoids exposing long-lived tokens and the proof-bound ticket is useless without the private key (`EnvironmentAuth.ts:582-586,1244-1295`; `docs/internals/environment-auth.md:73-87`). Browser cookie sessions can authenticate by their cookie instead. Media tickets stay bearer because one ticket is reused by `<img>`, EventSource and multiple media sockets, which cannot conveniently each send proof (`environment-auth.md:73-83`).

For Mowgli Connect, standard browser `WebSocket` cannot set arbitrary Authorization headers: use a short-lived WS ticket, ideally cookie-based same-origin auth or a `wsTicket` query value with very short expiry and route binding. Query-string secrets can appear in logs/history/telemetry, so redact them. If using a proof-bound access token, carry a single-use DPoP proof in the query too, not the long-lived bearer token.

## 5. Tenant isolation and explicit threat defenses

- Stable tunnel name/hash includes stage, account and environment; database primary key is `(userId, environmentId)`, hostname/tunnel name are unique (`deploymentConfig.ts:85-90,125-132`; `schema.ts:65-113`). Relay endpoint resolution comes from its own allocation record, never a client-provided URL. Per-user capacity is transaction-locked (`ManagedTunnelLimits.ts:151-217`).
- Link proof is signed by the environment’s key, short-lived and one-use; relay challenge binds the link to the logged-in account and requested capabilities. Mint is DPoP key-bound, nonce-bound, exact audience/scope and replay guarded. Relay signs mint requests; environment signs responses; environment does not hand back an environment session token to relay (`t3-connect.md:44-65`; `EnvironmentLinker.ts:189-280`; `CloudLink.ts:1551-1604`).
- Tunnels are restricted to an allowlisted validated loopback origin. Forwarded authority headers are rejected, caller-supplied destinations are not trusted, and health/mint fetches do not follow redirects. This blocks SSRF through relay endpoint discovery and helps prevent reaching another process on the host (`t3-connect.md:67-72`; `EnvironmentLinker.ts:283-289`; `EnvironmentConnector.ts:647-666`).
- Unlink authorization revocation precedes external resource deletion; allocation generation claims stop delayed cleanup from deleting a resource that a concurrent relink has adopted (`t3-connect.md:94-99`). Reaper skips untracked/orphan resources rather than risking deletion of a concurrent allocation (`t3-connect.md:112-122`).
- The trust model is explicit: relay is trusted with its cloud mint private key, so a compromised relay signing key can mint connection requests. Client DPoP protects stolen tokens but does not neutralize that trusted key (`t3-connect.md:63-65`). Cloudflare Tunnel gives connectivity/TLS/routing, not app-level identity or authorization.

## 6. Hot path, control plane, data stores, identity, costs

### Hot path vs control plane

- **Hot path:** Browser/client -> Cloudflare edge/Tunnel -> host `cloudflared` -> Go/Node environment server. Client HTTP APIs and WebSockets go directly to the environment hostname; payloads do not pass through relay. The host server remains the actual authorization boundary. Stable public disclosure also states app/provider traffic does not go to T3’s relay (`infra/relay/README.md:6-12`; `docs/internals/t3-connect.md:3-6`; `docs/user/faq.md:72`).
- **Control plane:** Clerk sign-in and relay account APIs; listing links/status; link challenge/proof verification; tunnel/DNS provisioning and connector token delivery; DPoP access token issuance; one connect-time relay-to-environment mint exchange; unlink/recovery/reaping. Mobile notifications and optional held webhooks are extra relay features, not needed for normal browser control (`infra/relay/README.md:15-29`; `t3-connect.md:14-34`).

### Storage and identity

- Relay is a Cloudflare Worker, uses PlanetScale Postgres via Cloudflare Hyperdrive (unnamed statements due transaction-pooling collision), and Cloudflare Tunnel/DNS bindings. `prod` owns retained PlanetScale DB; development stages use separate branches (`infra/relay/src/worker.ts:164-189`; `infra/relay/README.md:94-111`). Schema tracks links, allocations, hashed host credentials, and DPoP replay IDs (`schema.ts:65-148,188-200`).
- Clerk handles hosted identity: relay verifies Clerk JWT/OAuth bearer input and its audience. Environment login remains separate, locally issued and enforced. Cloud mint signing keys are relay secrets, with public key delivered to host as link configuration (`worker.ts:164-166,228-249`; `Api.ts:850-867`; `CloudMintSigner.ts:18-37,53-90`).
- Cloudflare account API credentials are deployment-time Alchemy inputs; the runtime Worker receives Cloudflare Tunnel and DNS bindings rather than a broad API token in ordinary request config (`worker.ts:185-189,565-566`; `infra/relay/README.md:128-169`).

### Costs mentioned

- T3’s internal architecture note explicitly says Cloudflare bills an allocated tunnel even when no connector is attached, motivating release and reaping (`docs/internals/t3-connect.md:101-107`). User docs say T3 Connect is free “for now,” note 3 / 10 / 100 caps, and warn the bill could force a change (`docs/user/faq.md:28-32`). No exact unit prices, PlanetScale charges, Clerk pricing, or per-robot cost are specified in the inspected material. Don’t infer that free-tier Workers/D1 make an equivalent service entirely free: tunnels, domain ownership, and any non-free limits are separate costs.

## 7. Copy vs skip; minimal Mowgli Connect design

### Copy

1. **Keep app traffic off the relay.** Let Cloudflare Tunnel route directly to the robot; use the Worker only for identity, device registry, tunnel/control-plane bookkeeping, and short-lived credential bootstrap. This is the key architecture property.
2. **Authenticate at the robot too.** A tunnel URL is public and non-secret. Add robot-side auth even if the current Go API has none. Require a short-lived app session for REST and WebSocket handshakes; enforce authorization in Go, not only at Cloudflare.
3. **Use link ownership proof.** During onboarding, show a high-entropy, short-lived one-time robot pairing code locally (QR/manual entry); user signs into Mowgli account and submits the code. Robot then pins the account/device public key and registers its robot ID and tunnel hostname with the control plane. Consume the code atomically and expire quickly. This is a simpler human-friendly adaptation; T3’s environment signing/challenge protocol is stronger against relay/origin impersonation but is a lot of machinery for a small service.
4. **Use short-lived bootstrap grants.** Worker authenticates user, checks that account owns robot, then issues/relays a one-time grant with robot ID, user/account ID, audience, expiry, nonce and scope. Robot verifies the grant signature against a pinned Worker public key, consumes nonce, and issues its own local cookie/session. Do not use the tunnel token as user auth. A signed token lets robot authenticate without a per-request Worker call; short expiry and robot-side refresh/revocation keep control.
5. **Bind sessions to robot and audience.** Include robot ID in `aud`/claims and validate exact hostname/robot at both Worker and Go boundaries. Use cookie `HttpOnly; Secure; SameSite` for browser flow, CSRF/origin checks for state-changing REST. For WebSockets, mint a route-bound, single-use short ticket over authenticated HTTP; verify it in Go and redact query params.
6. **Restrict tunnel origin.** Provision exactly one ingress from hostname to loopback `127.0.0.1:<Go port>` and default 404. Never let users supply arbitrary target URLs. Ensure public tunnel hostname cannot reach other robot LAN services.
7. **Keep records minimal and revocable.** Worker + D1 tables: accounts (from chosen identity provider); robots `(robot_id, owner_account_id, hostname, tunnel_id, public_key, status, created_at)`; pairing codes (hashed code, robot, expiry, consumed); optional device sessions/revocation version. Do not persist plaintext user/session/tunnel tokens. KV is unnecessary for authoritative ownership or single-use code consumption; D1 transactions/unique constraints are a better fit. KV can cache public, non-authoritative discovery/config only.
8. **Store connector token on robot only.** During activation deliver token securely once to robot process/config. Do not return it to browser. Rotate/revoke by deleting/replacing tunnel as needed.

### Defer as overkill

For 1–30 robots, omit T3’s managed tunnel plan quotas and paid-account integration, multi-client OAuth and native identity complexity (Clerk + WorkOS account linking), generic environment scope vocabulary, DPoP proof replay DB for every relay call, signed request and response framework for all environment operations, PlanetScale plus Hyperdrive, Alchemy infrastructure abstraction, per-stage zones and preview tunnel sweeps, dual-version cloudflared update handoffs, recovery-signature machinery, rate-limit pause coordination, mobile notification queues, held webhook Durable Objects, detailed tracing pipeline, and extensive inactive tunnel census/reaper logic.

Keep the design extensible: persistent tunnel-to-robot allocation, idempotent provisioning, deletion on unlink, and a simple scheduled check for orphaned/down tunnels are enough at first. Choose whether each robot gets a distinct hostname/tunnel (simpler isolation and revocation, more resources) or share one tunnel with hostname routes (cheaper, but more complex cross-robot ingress isolation). For this small fleet, prefer one tunnel per robot so a compromised connector or teardown stays scoped.

### Minimal end-to-end flow

```text
Robot setup -> create tunnel + hostname -> run cloudflared outbound to 127.0.0.1:4006
      | register robot ID, public key, hostname with Worker
      v
Browser -> login (OIDC) -> Worker checks owner -> short-lived, robot-audience bootstrap grant
      |                                                       |
      +---------------------- direct HTTPS/WSS via tunnel <---+ (Worker not in data path)
                                      |
                               Go verifies grant once,
                               issues local session/cookie
                               REST + WS auth enforced locally
```

For an initial implementation, the key architectural decision is not D1 versus KV: it is making the robot API independently authenticated, since the described current GUI/server has no built-in auth. A private tunnel provides reachability and encryption but does not make the origin safe from anyone who learns its hostname.
