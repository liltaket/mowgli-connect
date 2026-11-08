# Mowgli Connect security review 3

Reviewed 2026-11-08. Baseline: **`3fec25733f091bc3b82410e299400b37521e4b21` on main**. This is an independent, read-only source review, with only this report written. Concurrent edits to agent/relay sources, tests, and configuration appeared during the review; they are outside this assessment and were left untouched. Locations below refer to the baseline commit, not those later edits.

The supplied deployment description is assumed: public relay on Workers Free, `PROVISIONER=quick`, and one allowed numeric GitHub identity. No deployed configuration, edge rules, Cloudflare/GitHub API, live tunnel, real credential, or robot was inspected or used. The first two reviews and their status sections were read; their resolved findings are not repeated as new findings.

**Verdict:** no Critical/High issue or unauthenticated path to robot control was established. The core grant/session boundary is coherent. There are confirmed gaps in established-socket authorization, viewer confidentiality, and unauthenticated resource controls. The current owner-only trial has less exposure than a deployment with viewers; the public relay's availability risks already apply. Fix the Medium findings before offering shared access to approximately 30 users.

## Summary

| ID | Severity | Title | File:line |
|---|---|---|---|
| MC3-01 | Medium | Established WebSockets survive logout and retain routes forbidden after downgrade | `agent/internal/gateway/ws.go:115` |
| MC3-02 | Medium | Viewers can retrieve unredacted mower configuration through `/api/settings` | `agent/internal/gateway/policy.go:60` |
| MC3-03 | Medium | Relay request-body limit is applied after complete buffering | `relay/src/util.ts:50` |
| MC3-04 | Medium | Public login and replay writes bypass the registration resource cap; Worker quota remains exposed | `relay/src/oauth.ts:14`, `relay/src/robotApi.ts:43` |
| MC3-05 | Low | Consumed grants become reusable after a restart within the skew window | `agent/internal/gateway/gateway.go:325` |
| MC3-06 | Low | HTML injection silently truncates responses larger than 4 MiB | `agent/internal/gateway/httpopt.go:53` |
| MC3-07 | Info | Health ticks override the configured claimed-robot polling interval | `agent/cmd/connect-agent/main.go:355` |

All seven findings are **CONFIRMED**, by the traces and local checks below. This does not imply reproduction against the deployed service.

## MC3-01 — Established WebSockets survive logout and retain forbidden routes after downgrade

**Medium · CONFIRMED.** The five-second socket recheck validates a retained `*session`; it neither checks that the session still exists in `g.sessions` nor reevaluates the route policy for its current effective role. Logout deletes the map entry, leaving the object referenced by each open socket intact. A downgrade returns a nonempty `viewer` role, which also passes the socket check.

**Scenario and preconditions:** someone with a valid session opens a socket before logout. An operator logs that session out, or the browser posts `/_connect/logout`; new requests lose authorization, but that socket keeps relaying until expiry, an epoch/status/member invalidation, or disconnect. An owner-only container-log socket remains readable after the member becomes a viewer. If teleop was explicitly enabled, an already-open publish socket likewise keeps accepting commands after downgrade to viewer. This requires prior legitimate access; it is not an unauthenticated opening of a socket. The current single-owner deployment principally exposes the logout case.

**Evidence:** `connect.go:69–74` removes only the table entry:

```go
delete(g.sessions, key)
g.persistLocked()
```

`gateway.go:185–199` checks status, epoch, expiry, freshness, and membership against the object, without session-table membership. The only periodic authorization test in `ws.go:115–119` is:

```go
if g.effectiveRole(sess) == "" {
    // send close and return
}
```

The policy is called only at the initial HTTP handshake (`gateway.go:246`). In-memory Go checks reproduced both conditions: after an actual logout handler returned 204, `sessionFrom` returned nil but `effectiveRole(savedSession)` still returned owner; after a downgrade it returned viewer even though the policy denied `/api/containers/x/logs` for that role.

**Recommended fix:** make socket authorization check that the original session is still registered, using its token hash/session identity or an explicit revocation marker, and rerun `Policy.Allow(currentRole, originalMethod, originalPath, true)` on each recheck. Alternatively close tracked sockets directly on logout/downgrade. Add checks for logout and owner-to-viewer downgrade of an owner-only route, preserving the documented periodic recheck allowance.

## MC3-02 — Viewer policy exposes unredacted configuration

**Medium · CONFIRMED.** The viewer deny list blocks YAML configuration but permits `GET /api/settings`. The upstream returns all parsed shell configuration, including unknown keys under `custom_environment`, without removing secrets. Thus blocking only YAML is not a confidentiality boundary.

**Scenario and preconditions:** an owner configures a viewer membership and the mower configuration contains an NTRIP password or another credential. The viewer can directly fetch `/api/settings` with their ordinary session and read it. They do not need the viewer UI to work. There is no viewer-sharing UI today and the supplied deployment allows only one GitHub identity, so this is dormant until viewer memberships are used.

**Evidence:** `policy.go:60–63,87`:

```go
var mowgliViewerDeniedGET = []string{
    "/api/config/", "/api/settings/yaml", "/api/remote-access/", /* ... */
}
// ...
return safeMethod(method) && !hasAnyPrefix(path, mowgliViewerDeniedGET)
```

A local policy check confirmed viewer GET `/api/settings` is allowed while `/api/settings/yaml` is denied. To establish what the endpoint returns, the existing local MowgliNext source was inspected read-only at **`4739f41fb4e9473da2c5a5868f4c7d1a589e7b7c`**, the same baseline cited in `docs/research/mowgli-gui-traffic.md:3,14`. Its `gui/pkg/api/settings.go:1290–1335` reads and parses the configured shell file, then:

```go
for k, v := range settings {
    if knownKeys[k] || k == "custom_environment" {
        // coerce type or copy v into finalSettings
    } else {
        customEnv[k] = v
    }
}
finalSettings["custom_environment"] = customEnv // when nonempty
c.JSON(200, GetSettingsResponse{Settings: finalSettings})
```

That source explicitly handles `gnss_ntrip_password`/`ntrip_password` (`settings.go:811`). No actual configuration file or secret value was read. This establishes the source-level disclosure for that upstream version, not the contents of a deployed mower.

**Recommended fix:** deny viewer access to `/api/settings` immediately. Prefer an explicit viewer allow list of telemetry/static routes over a growing deny list; audit other aggregate configuration/parameter responses before allowing them. If viewers need selected settings, provide a deliberately redacted response rather than forwarding the administrator response. Test the policy against a harmless synthetic credential sentinel.

## MC3-03 — Body-size rejection happens after unbounded buffering

**Medium · CONFIRMED.** `readBodyText` advertises a byte limit but allocates and reads the entire request first. Registration calls it before assertion authentication. Consequently the advertised 4 KiB JSON limit does not limit memory or time spent receiving an unauthenticated body.

**Scenario and preconditions:** any client able to reach `POST /v1/robots/register` sends a large or slowly streamed body without a robot assertion. The Worker receives/buffers it before returning a rejection. Parallel requests can pressure isolate memory and service availability. No GitHub account, valid key, or pairing code is necessary. The platform's own request limits still apply; this finding does not assert an unlimited edge upload allowance or a measured production OOM threshold.

**Evidence:** `util.ts:50–53`:

```ts
const buf = await request.arrayBuffer();
if (buf.byteLength > max) return null;
return new TextDecoder().decode(buf);
```

`robotApi.ts:73–75` invokes `readJson(request)` before authentication at lines 89–95; `readJson` passes a default maximum of 4096 at lines 57–59. A local invocation of the committed helper with six 4096-byte stream chunks consumed **all 24,576 bytes** before returning null for a 4096-byte limit. This proves the missing application bound without stressing memory or making network requests.

**Recommended fix:** read the stream incrementally, count bytes, and cancel as soon as `max + 1` bytes would be exceeded. Reject a known oversized Content-Length early as an optimization, while enforcing the bound independently for streamed bodies. Retain an appropriate receive deadline/admission limit. Test that an oversized stream is canceled without draining its remaining chunks.

## MC3-04 — Public write paths and shared request quota remain unprotected

**Medium · CONFIRMED in application code; deployment impact is conditional on traffic reaching the Worker.** The new-registration cap bounds some robot rows, not requests or all database writes. Unauthenticated `/login` inserts a new OAuth row on every request. Registration consumes a `jti_seen` insert before checking the cap. Neither path needs a permitted GitHub identity; the allow list is checked only after completing OAuth or when looking up an existing browser session.

**Scenario and preconditions:** an internet client repeatedly fetches `/login`, discards cookies, and does not follow its GitHub redirect. Every request writes D1 state. Alternatively, it self-signs registrations with fresh JTIs; even requests rejected by the robot cap write replay rows. These requests consume the shared daily allowance supplied in the task. Even a cheap repeated 404 can consume Worker invocations if admitted to the Worker; in-handler 429 responses cannot protect that invocation quota. Sustained exhaustion prevents robot refreshes, and agents then deny remote access after `MC_MAX_STALE`. Other Workers in the same free account share the stated budget. No inference is made about uninspected edge controls.

**Evidence:** `browser.ts:160–163` calls `startLogin` for any unauthenticated GET `/login`. `oauth.ts:14–21` generates fresh random state and unconditionally runs:

```ts
await env.DB.prepare("INSERT INTO oauth_states (state_hash, code_verifier, return_to, expires_at) VALUES (?, ?, ?, ?)")
  .bind(await sha256Hex(state), verifier, safeReturnPath(returnTo), now + OAUTH_TTL_SECONDS)
  .run();
```

`robotApi.ts:43–46,91,114–125` inserts replay state before querying/counting recent robots and returning 429. `jti_seen.robot_id` has no robot foreign-key constraint (`migrations/0001_init.sql:74–79`), so an identity rejected by the robot cap can still leave replay rows. The robot COUNT and INSERT are also separate operations rather than an atomic admission gate. Cleanup is periodic, not admission control (`index.ts:37–46`).

Local calls to the committed Worker with an in-memory DB double confirmed **ten unauthenticated `/login` requests produced ten OAuth INSERTs**, with no external fetch. A correctly self-signed registration with the cap already reached returned **429 after inserting one replay row**. The double verifies application ordering; it is not a D1 load or concurrency test.

**Recommended fix:** apply a bounded per-source and global admission budget to login starts and robot registration before expensive work/writes. Make new-robot admission atomic; avoid recording unlimited registration replay state for identities denied admission, while preserving single-use protection for accepted assertions. An invitation/bootstrap gate can narrow enrollment for this hobby relay. Protect the shared invocation quota with enforceable controls *before Worker execution*, or move the relay to a separately budgeted service/account/plan if such ingress controls are unavailable on this hostname. Application rate limits alone cannot solve the 100k/day invocation exposure. Reserve headroom for `/self` and monitor usage.

This extends the first review's registration finding: the cap is present and useful, but the public write bypasses above remain. It is not a claim that the earlier cap was never implemented.

## MC3-05 — Restart permits replay of a recently consumed grant

**Low · CONFIRMED.** Grant JTIs are process-local, whereas the startup cutoff deliberately accepts grants issued up to 30 seconds before the new process started. Their combination leaves a cross-restart replay window despite the contract's single-use claim.

**Scenario and preconditions:** an attacker obtains a copy of a legitimately issued, already-consumed grant, and the agent restarts no more than approximately 30 seconds after its issuance. After a fresh relay sync, the attacker redeems that same grant for a new 12-hour session. Membership and epoch must still authorize the user; the attacker cannot change claims. This requires a leaked bearer grant plus a timely restart and does not defeat epoch revocation.

**Evidence:** `gateway.go:106–110` initializes an empty `jtis` map on every `New`; only sessions are restored (`sessions.go`). `gateway.go:325–326` rejects only:

```go
case iat.Before(g.start.Add(-ClockSkew)):
    return "", nil, grantError("issued before agent start")
```

`ClockSkew` is 30 seconds; replay consumption at `gateway.go:355–358` only consults the new map. An in-memory test redeemed one grant, confirmed the immediate replay was rejected, created a new gateway five seconds later with the same state and a fresh sync marker, and successfully redeemed the identical grant again.

**Recommended fix:** persist consumed JTIs until `exp + ClockSkew`, using the same protected data-volume trust model as sessions. Another option is a per-process challenge included in grants, with the resulting protocol change. Removing startup skew alone should be considered only with a deliberate clock-synchronization requirement. Add a restart replay regression check; keep old-epoch rejection intact.

## MC3-06 — Injection truncates oversized HTML instead of passing it through

**Low · CONFIRMED.** The injection reader keeps at most `maxInjectHTML + 1` bytes, closes the upstream body, and installs only the buffered prefix as the entire downstream response even when it detects that the page is too large. The comment promises oversized pages pass through untouched.

**Scenario and preconditions:** an authenticated user requests an HTML document larger than 4 MiB with `Accept: text/html` or the document fetch destination, while the default compression feature is enabled. The upstream must actually return HTML 200; an attacker cannot turn an arbitrary JSON response into this case through Accept alone. The browser receives a truncated document with a successful status and a rewritten Content-Length, potentially losing scripts, forms, or diagnostic content. No such large normal Mowgli index page was established, so this is a conditional availability/integrity defect, not a demonstrated route to robot control.

**Evidence:** `httpopt.go:53–63`:

```go
body, err := io.ReadAll(io.LimitReader(resp.Body, maxInjectHTML+1))
resp.Body.Close()
// injection is conditional on len(body) <= maxInjectHTML
resp.Body = io.NopCloser(bytes.NewReader(body))
resp.ContentLength = int64(len(body))
```

A direct local check supplied 4,194,417 HTML bytes and received **4,194,305** bytes back, with the suffix lost. The read cap bounds each injection buffer; it does not preserve the source stream.

**Recommended fix:** retain the original body until the size decision. For oversized HTML, replay the buffered prefix and then the unread original stream with a composite ReadCloser; preserve original length/validators because the bytes are unchanged. Optionally skip buffering immediately when a trustworthy known response length already exceeds the threshold. For modified documents, invalidate or weaken strong content validators. Test exact boundary sizes and unknown-length responses.

## MC3-07 — Health events cause extra relay polls

**Info · CONFIRMED by control flow.** The two-minute health ticker wakes the same loop whose top unconditionally calls `/self`. With the default three-minute claimed poll interval, a health event arrives first and starts another poll; the three-minute timer is recreated afterward. This also happens in named mode: the quick-mode condition skips the self-check, not the following loop iteration.

**Scenario and preconditions:** a normally healthy, claimed robot uses default configuration. Ignoring request duration and other wakeups, it makes approximately **720 `/self` calls/day**, rather than the documented 480. Thirty claimed robots therefore use approximately 21,600 daily self polls rather than 14,400. These are estimates from timer ordering, using the task's supplied quota, not production traffic measurements. Hostname reports/resyncs can add calls. This does not exhaust 100k/day by itself but reduces the advertised headroom.

**Evidence:** `main.go:277` creates `time.NewTicker(2 * time.Minute)`; `main.go:297` always calls `client.Self(ctx)` at the top of the next iteration. `main.go:355–365` chooses health or polling from one select:

```go
case <-health.C:
    if quick && pendingHost == "" && current != nil && current.Hostname != "" {
        // self-check
    }
case <-time.After(wait):
}
// next iteration calls Self regardless of which event fired
```

**Recommended fix:** track the next relay-poll deadline independently from health checks. Poll only when that deadline expires or an explicit resync/hostname event requires it. Preserve the fast-unclaimed startup window and failure backoff, and document the resulting actual budget. A fake-clock event-loop check should establish that health-only wakeups do not issue `/self`.

## Checked and found sound within this scope

- **Agent ingress and bootstrap:** claimed-status and exact hostname checks precede routing; reserved routes are matched exactly by method/path and never fall through to the GUI. Session creation needs the robot Origin and a signed grant; unknown bootstrap routes return 404. Canonical-path checks reject dot segments, repeated slashes, backslashes, and encoded slashes. No demonstrated method/alternate-upgrade/path bypass was found (`gateway.go:208–260,389–405`, `connect.go:42–113`).
- **CSRF and relay redirects:** unsafe agent HTTP requests and WebSocket handshakes require the exact robot Origin. Browser mutations at the relay require its exact Origin. OAuth GETs use a random host-only state cookie and an atomic, expiring state consume plus PKCE; return paths reject scheme-relative URLs, backslashes, and control characters. Claim GET only previews. No login-state bypass, return-to open redirect, D1 injection, or header-injection path was found (`oauth.ts:14–112`, `util.ts:37–39`, `browser.ts:145–188`). Pairing uses unbiased 50-bit codes, hashed storage, an atomic consume, and ten failed attempts/hour/user; parallel overshoot of a count-based limit does not make blind guessing practical at this scale.
- **Grant and session cryptography:** Ed25519/type/key checks, exact issuer/audience, bounded grant lifetime, epoch, and membership are enforced. JTI consumption is mutex-protected within a process. Cookies are new random 256-bit values, host-only, Secure/HttpOnly/Lax; only hashes are persisted, and the gateway cookie is stripped before HTTP/WS forwarding. The upstream cannot normally set that exact cookie through HTTP responses. The exception to cross-restart single-use is MC3-05. No session fixation or cross-robot grant confusion was established.
- **New resync path:** only a correctly signed grant that has passed issuer/audience/time checks can request resync, and the gateway throttles calls under its mutex to one per ten seconds. Untrusted unsigned requests cannot directly force relay polling through this callback. The channel is bounded and the gateway wait has a ten-second timeout. Current state still controls subsequent session use; a resync failure does not bypass epoch/membership/freshness enforcement (`gateway.go:297–382`, `main.go:195–212,337–346`).
- **Freshness:** cached startup state alone is insufficient; normal construction supplies a positive MaxStale and main marks fresh only after successful responses are applied. New requests fail closed after staleness. Epoch changes/status revocation/member removal invalidate sockets on recheck. Five seconds is the nominal recheck period, not a real-time guarantee during scheduling/write stalls. MC3-01 concerns different invalidation conditions that the recheck never recognizes.
- **HTML/script and caching changes:** injection uses a constant same-origin script tag, without interpolating grants, names, or request text; no new XSS source was established. Bootstrap pages retain a restrictive CSP and use textContent for errors. The upstream GUI remains a trusted same-origin application capable of privileged requests if it has its own XSS. Ordinary upstream public asset caching is rewritten to private, so no shared-cache bypass was found under the normal origin-cache policy. External cache overrides were not inspected. Injection's confirmed failure is MC3-06; no response-splitting path was found.
- **WebSocket compression, parser, and lifecycle:** the agent compresses downstream data; it does not accept/decompress the custom framing from unauthenticated clients. Both socket legs have a 64 MiB per-message read limit. The MessagePack skipper is iterative, checks lengths, and advances its cursor, so malformed counts do not induce recursion or an unbounded count-only loop on the intended amd64/arm64 builds. It only selects a throttle bucket, not an authorization decision. The throttle keeps one pending frame per configured topic. Channel close synchronizes the read-error handoff; closing both sockets on handler exit unblocks their reader pumps. No deterministic new goroutine leak or data race was established. Per-connection buffers and the browser's asynchronous decode queue still need realistic low-memory-device/load testing; no aggregate connection/backlog limit was found. Existing tests and the targeted checks are not a proof of safety under arbitrary authenticated load.
- **HTTP gzip:** streaming compression is downstream of authorization, uses a pipe, and the response-reader close plus outbound request cancellation provides the normal client-disconnect cleanup path. No deterministic production leak was established. SSE is excluded. A generic blocking custom body would not establish a reachable production leak by itself.
- **Quick mode:** report authentication derives identity from the robot key and binds method/URL/audience; only that claimed robot's row can be updated. Hostname validation excludes URL syntax, ports, nested labels, foreign suffixes, and control characters. Database uniqueness prevents overwriting a hostname already assigned to another robot. `/open` requires membership and grants remain bound to that robot ID. The log parser is fed by a local cloudflared process, not HTTP input; no remotely injectable hostname path was established. Reporting/resync retries are bounded by main's waits/backoff. Ownership of an arbitrary reported Quick Tunnel is still not proved, as already recorded in review 2.
- **Public repository exposure:** inspected the 93 tracked paths and the single commit reachable from local main, including configuration, key-generation/test fixtures, deployment workflow, and committed test/research output. Targeted secret-pattern scanning and source inspection found no real private signing key, robot seed, GitHub token/client secret, connector token, or live session/grant. Wrangler configuration contains placeholders and tests generate disposable keys. Local ignored secret files were not inspected or copied. Public GitHub refs/artifacts and private checkpoint refs were not audited; publication state is supplied by the task. No credential leak was established.

## Earlier residual risks and suitability for a hobby deployment

- **Freshness/revocation delay:** the earlier indefinite-staleness issue is fixed. With healthy relay access, main normally learns a remote revoke only on its next actual poll, then existing sockets have a nominal additional five seconds. During an outage, stale authorization can last up to the configured ten minutes plus socket processing delay. This is acceptable for a clearly described hobby remote-administration service with local safety controls and teleop disabled; it should not be described as instantaneous revocation or used as an emergency-stop guarantee. MC3-01 must still be fixed.
- **Session-file integrity:** accepting the protected data volume as the robot's root of trust is reasonable here. A writer there can replace the robot key as well as session hashes. Mode 0600, atomic writes, expiry bounds, current epoch/member checks, and fresh startup synchronization remain useful. This accepted local-write threat is not relisted as a new finding.
- **Plaintext connector token in D1:** still present for named tunnels (`migrations/0001_init.sql:39–40`); quick mode provisions/stores null tokens. Therefore it does not expose a connector secret in the described quick deployment. Keeping it temporarily for an owner-operated prototype is a documented tradeoff, but encrypting stored tokens and handling rotation is appropriate before a shared named-tunnel service. Database read access is enough to steal a named connector; it should not be treated as harmless telemetry access.
- **Quick-hostname trust:** acceptable while the only allowed owner controls all claimed robot keys and trials tolerate hostname changes/outages. A malicious or compromised robot can choose a different syntactically valid Quick Tunnel for its own members; uniqueness/audience checks are not host ownership proofs. Before accepting untrusted robot operators or sharing with less-trusted members, bind reported hosts to an agent challenge/identity or use controlled named-tunnel provisioning. No Cloudflare hostname reassignment/takeover was demonstrated here.
- **Availability and scale:** approximately 30 healthy claimed robots fit the task's stated daily request allowance even with MC3-07. That capacity arithmetic does not defend the now-public relay from MC3-03/04, or from other Workers consuming the same budget. The GitHub allow list limits account access, not public request cost. Those availability gaps are not adequately mitigated merely by having only 30 users. Viewers should remain disabled until MC3-01/02 are addressed; robot/hardware safety and uplink behavior still require their own evidence.

## Validation and limits

- Full agent suite attempted with `GOPROXY=off /tmp/mowgli-simulator-go/go/bin/go test ./...`. Gateway tests could not proceed because `httptest` could not bind `[::1]:0` (`operation not permitted`). Identity and tunnel packages passed; other listed packages had no tests. This is an environment limitation, not a finding.
- Existing no-listener gateway checks passed: `go test ./internal/gateway -run '^(TestMsgpackTopic|FuzzMsgpackTopic|FuzzCanonicalPathPolicy)$' -count=1`. The fuzz functions ran their seed cases; this was not a fuzzing campaign.
- Five additional no-listener Go checks ran through an anonymous-memory `go test -overlay` harness, with no added source files: logout object validity, downgrade policy mismatch, consumed-grant replay after restart, viewer settings policy, and oversized-HTML truncation. All reproduced the behavior described above. These are code-level checks, not live WebSocket/tunnel or hardware tests.
- Relay `npm test` could not start its seven worker pools: local bind to `127.0.0.1` failed with EPERM, and Wrangler log creation failed with EROFS. No relay suite test case ran. No permission escalation was attempted.
- Additional local Node checks transpiled the **committed** TypeScript in memory and used native Request streams and an in-memory DB double: full-body consumption beyond the limit, unauthenticated OAuth inserts, and replay-table insertion before registration 429 were reproduced. No fetch to GitHub/Cloudflare or other network service was made.
- Earlier recorded successful suites/browser/simulation results were treated as historical evidence only. No deployment, public API, real robot, physical safety behavior, full D1 concurrency, browser decode/backpressure stress, or Cloudflare edge-cache/WAF configuration was validated in this review.

## Status after fixes (lead, 2026-11-08)

All seven findings were fixed in the commit after `3fec257`, with regression tests:

| ID | Fix | Test |
|---|---|---|
| MC3-01 | Socket recheck now requires the session to still be registered (by token hash) and valid, and reruns `Policy.Allow` with the current role. | `TestSocketEndsOnLogoutAndDowngrade` |
| MC3-02 | Viewer policy is an allow list: the app, `GET /api/system/info`, `/api/system/versions`, `/api/schedules`, `/api/weather`, the multiplex/subscribe sockets. All other `/api` is denied, including `/api/settings` and unknown future endpoints. | `TestViewerAndMembership` (extended) |
| MC3-03 | `readBodyText` rejects a declared oversized `Content-Length` unread and otherwise streams, cancelling as soon as the limit is passed. | `request body limit` tests |
| MC3-04 | `/login` writes nothing to D1; login state is in the `__Host-` cookie, and replay fails at GitHub's single-use code. Registration admits new identities before authentication, so a capped identity writes no `jti_seen` row, and the cap check plus insert is one atomic statement. The residual risk is Worker request quota: a public `workers.dev` Worker can always be invoked, and there is no WAF without a zone. It is accepted for the prototype, because the relay runs in its own Cloudflare account and cannot affect other services. | `starting a login writes nothing`, `rejects expired or malformed login cookies`, rate-limit test |
| MC3-05 | Consumed JTIs are persisted in `sessions.json` until `exp + skew`, and old bare-list files still load. | `TestGrantNotReusableAfterRestart` |
| MC3-06 | HTML over 4 MiB, or with a larger declared length, is passed through unchanged as the buffered prefix plus the rest of the stream. | `TestLargeHTMLPassesThroughUnchanged` |
| MC3-07 | Relay polling has its own deadline. Health ticks and hostname reports no longer trigger `/self`, and a failed hostname report retries after 10 s. | Control flow only, no unit test. Verified by reading `main.go`. |

Also fixed in the same change, from live testing: relay forms were rejected as cross-origin. `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on form POSTs. The relay now uses `same-origin`, and both the relay and agent accept a null Origin only with `Sec-Fetch-Site: same-origin`, never for WebSocket upgrades.
