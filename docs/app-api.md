# Native app API (iOS)

Status: designed 2026-11-08, implemented in the relay, **off until configured** (`APP_IOS_APP_IDS`).
This is the contract a native app (the Mowgli Next iOS app) uses to sign in to Mowgli Connect, list
its robots and open them. The robot side does not change: the app ends up with the same 60-second
grant and the same session on the robot as a browser does.

## Design goals

1. **No long-lived relay secret on the phone.** The app's identity is a P-256 key the app creates
   in the Secure Enclave, which cannot be copied out. Every relay call is signed with it and works
   once, within a minute. What the phone does hold is the robot's own session cookie (up to 12
   hours per robot, as in a browser); signing the device out, from the app or under Devices,
   ends those on the robots its owner owns at the robots' next sync, within 3 and at most 10
   minutes (see below).
2. **Only the genuine app receives the sign-in.** The result comes back on an HTTPS URL of the
   relay that iOS hands only to apps the relay names in its `apple-app-site-association` file
   (Team ID + bundle ID), when the app uses the system's `ASWebAuthenticationSession`. This
   protects the delivery; the relay cannot prove which app or which kind of key it talks to (that
   would need App Attest, a possible later addition), so a person who approves a sign-in in some
   other app's own web view is trusting that app.
3. **Nothing is issued without the person seeing it.** Every sign-in shows a consent page naming
   the device, and every device is listed under "Devices" on connect.bronc.app with a Sign out
   button.
4. **Same rules as the web.** Invitations, guests (people a robot is shared with), robot limits,
   the owner/operator/viewer roles, admin removal and "Sign everyone out" apply to the app
   exactly as to the browser. Sharing (finding an account, adding people, changing roles,
   removing, leaving), unlinking a robot and signing everyone out of it work from the app with
   the same operations and limits as the web page. Claiming a robot is `POST /v1/app/claim`.

## Flow

```mermaid
sequenceDiagram
    participant App as iOS app
    participant Web as ASWebAuthenticationSession
    participant Relay as connect.bronc.app
    participant Robot as <name>.bronc.app (agent)
    App->>App: Secure Enclave P-256 key, PKCE verifier, state
    App->>Web: /app/authorize?... (challenge, key thumbprint, device name)
    Web->>Relay: GitHub sign-in if needed, consent page
    Relay-->>Web: 303 https://connect.bronc.app/app/callback?code&state
    Web-->>App: callback (only this app, via associated domains)
    App->>Relay: POST /v1/app/token (code, verifier, public key), signed with the key
    Relay-->>App: device id
    App->>Relay: POST /v1/app/robots/{id}/grant, signed
    Relay-->>App: 60 s grant + hostname
    App->>Robot: POST /_connect/session {grant}
    Robot-->>App: session cookie (12 h); then the robot's own API
```

### 1. Authorize (browser sheet)

`GET /app/authorize` with:

| Parameter | Value |
|---|---|
| `redirect_uri` | exactly `https://<relay>/app/callback` |
| `code_challenge` | base64url SHA-256 of the PKCE verifier (43 characters) |
| `code_challenge_method` | `S256` |
| `state` | random, 16 to 128 characters of `[A-Za-z0-9._~-]` |
| `key_thumbprint` | base64url SHA-256 of the device public key's JWK thumbprint input (RFC 7638), 43 characters |
| `device_name` | shown to the person, e.g. "Bruno's iPhone" (cleaned, at most 40 characters) |

Not signed in: the relay sends the sheet through GitHub sign-in and back. Signed in: a consent page
("Sign in to the Mowgli app on Bruno's iPhone?"). **Allow** posts the form (Origin-checked); the
relay stores a one-time code (hash only, 60 seconds, bound to the user, the challenge and the key
thumbprint) and redirects to `redirect_uri?code=…&state=…`. **Cancel** redirects with
`error=access_denied`. In the app, configure the session with
`ASWebAuthenticationSession.Callback.https(host: "<relay host>", path: "/app/callback")` (iOS 17.4+).

### 2. Token

`POST /v1/app/token`, JSON:

```json
{"code": "…", "code_verifier": "…", "redirect_uri": "https://<relay>/app/callback",
 "device_key": {"kty": "EC", "crv": "P-256", "x": "…", "y": "…"}}
```

with `Authorization: MC-Device <jws>` signed by that key (see [Signed requests](#signed-requests);
`iss` is the key thumbprint). The relay checks the code (single use), the PKCE verifier, that the
key matches the thumbprint bound at authorize time, the signature, that the person still has
access and has fewer than 10 devices. Answer: `{"deviceId": "<thumbprint>", "login": "…", "name": "…"}`.

### Signed requests

Every app call carries `Authorization: MC-Device <jws>`: a compact JWS, header
`{"alg": "ES256", "typ": "mc-device+jwt"}`, claims:

| Claim | Value |
|---|---|
| `iss` | the device id (key thumbprint) |
| `aud` | the relay origin, e.g. `https://connect.bronc.app` |
| `htm`, `htu` | the HTTP method and the relay origin + path (no query) |
| `iat`, `exp` | seconds; `exp - iat` at most 60 |
| `jti` | random, 22 to 128 characters, never reused |

The signature is the raw `r || s` form (CryptoKit's `P256.Signing.ECDSASignature.rawRepresentation`).
Each `jti` is accepted once. Every call also re-checks that the device still exists and that its
owner still has access.

### 3. API

| Call | Result |
|---|---|
| `GET /v1/app/me` | `{login, name, robotLimit, robots}`; `robotLimit` is `0` for a guest (someone who can only open robots shared with them) |
| `GET /v1/app/robots` | `{robots: [{robotId, name, hostname, role, sharedBy, online, joystick, updateAvailable, simulator}]}`: robots the person owns and robots shared with them. `role` is `owner`, `operator` ("Can control") or `viewer` ("View only"); `sharedBy` is the owner's GitHub login for a shared robot, `null` for one's own; `joystick` and `updateAvailable` are `null` unless `owner`; `simulator` is `true` when the robot's agent says it is a simulator (`MC_SIMULATOR`, [protocol](protocol.md#robot-assertion-typ-mc-robotjwt)): show a Simulator badge. It is the robot's own claim, for display only, never for access decisions |
| `POST /v1/app/robots/{robotId}/grant` | `{grant, hostname, expiresAt}`, with the role stored for this person on the relay at this moment; `503 {"error":"robot_offline"}` if its tunnel is down |
| `GET /v1/app/robots/{robotId}/shares` | owner only: `{shares: [{userId, login, name, role, since, signedIn}], limit}`: who the robot is shared with (`role` `viewer` or `operator`, `since` in Unix seconds, `signedIn` false until they first sign in) |
| `POST /v1/app/robots/{robotId}/shares/lookup` | owner only, body `{login}`: step 1 of sharing, `{id, login, name, joinedYear}` for the owner to check before anything is shared; writes nothing. `400 bad_login`, `400 bad_request`, `400 no_such_account` (also an organization or bot), `400 own_account`, `409 already_shared`, `429 rate_limited` (20 lookups per person per hour, 300 for the relay), `502 github_unavailable` |
| `POST /v1/app/robots/{robotId}/shares` | owner only, body `{id, role}` with `id` from the lookup and `role` `viewer` or `operator`: step 2, looks the account up again by id and shares. `{ok, userId}`; `400 bad_request`, `bad_role`, `bad_id`, `own_account` or `no_such_account`, `409 already_shared`, `403 share_limit` (10 people per robot), `429 rate_limited` (10 shares per owner per hour, or the lookup budget), `502 github_unavailable` |
| `POST /v1/app/robots/{robotId}/shares/{userId}/role` | owner only, body `{role}`: `{ok}`; `400 bad_request` or `bad_role`, `404` for an unknown person or the owner's own row |
| `POST /v1/app/robots/{robotId}/shares/{userId}/remove` | owner only: `{ok}`; the person's robot sessions end at the robot's next sync (3 minutes, 10 at most), and if it was their last way in they are signed out of the relay |
| `POST /v1/app/robots/{robotId}/sessions/revoke` | owner only: signs everyone out of the robot, the owner's own sessions included (the session epoch goes up; ends at the robot's next sync, 3 minutes, 10 at most). `{ok}` |
| `POST /v1/app/robots/{robotId}/unlink` | owner only: removes the robot from the account, deletes its tunnel and ends every share on it (a guest whose last share it was is signed out of the relay). The robot needs a new pairing code to be claimed again. `{ok}`. The app should ask for confirmation first |
| `POST /v1/app/robots/{robotId}/leave` | a person the robot is shared with leaves it: `{ok, signedOut}`; `signedOut` is true when that was their last share, which also signed this device out (the next call answers 401) |
| `POST /v1/app/claim` | body `{code, label?, step: "preview"\|"confirm"}`: preview `{robotId, name, simulator, hostname}`, confirm `{robotId, hostname}`; same limits and guess budget as the web |
| `POST /v1/app/sign-out` | deletes this device and, in the same transaction, signs everyone out of the robots its owner owns (their session epoch goes up, so robot sessions and unused grants from before stop working at the robot's next successful sync: normally within `MC_POLL_INTERVAL`, 3 minutes, and at the latest after `MC_MAX_STALE`, 10 minutes, when the robot stops accepting anything until it syncs); pending sign-ins of that key are cancelled; robots the person only views are not touched. A second call answers 401 `unknown_device` |
| `GET /v1/app/delegations` | `{delegations: [{delegateId, name, scopes, expiresAt, revokedAt, lastUsedAt}]}`: the AI agents that may act for this person ([agent-delegation.md](agent-delegation.md)); empty when delegation is off for them |
| `POST /v1/app/delegations/{delegateId}/revoke` | ends that delegation now (`{ok: true}`; 404 if it is not this person's or already revoked). Renewing happens in the browser |
| `POST /v1/app/delegations/consent` | an AI agent's consent link, previewed, approved or declined in the app: see [AI agents](#ai-agents) |

### AI agents

The consent link `mc-delegate request` prints (`/delegate/authorize?key=…&req=…`,
[agent-delegation.md](agent-delegation.md#2-consent)) can be approved in the app as well as on the
web page. The app takes the link's `key` and `req` unchanged and calls
`POST /v1/app/delegations/consent` (body up to 8 KB), signed as every app call. The relay answers
404 when delegation is off or the person is not in `DELEGATION_USERS`, and 503 `paused` under the
emergency stop.

`{"step": "preview", "key": "…", "req": "…"}` writes nothing and answers what the consent page
shows, with the page's own texts:

```json
{"delegateId": "abcdefghijk2345a", "fingerprint": "abcd-efgh-ijk2-345a", "name": "Claude (T3, laptop)",
 "login": "liltaket", "linkExpiresAt": 1800001200,
 "scopes": [{"scope": "robots:read", "title": "See robots", "text": "List the robots below…", "limits": null}],
 "never": ["Drive a robot or start mowing", "…"],
 "robots": [{"robotId": "…", "name": "Sim Farm", "role": "owner", "detail": "You own it",
             "simulator": true, "ticked": false, "addedByAgent": false}],
 "robotsNote": "Nothing is ticked unless you tick it.", "noRobots": "You have no robots yet. …",
 "ttl": {"choices": [{"seconds": 3600, "label": "1 hour"}, "…"], "default": 86400},
 "existing": null}
```

`name` is the agent's own choice: show it as text, marked as chosen by the agent, and show the
fingerprint prominently with the page's warning. `robots` are the person's robots; `ticked` is
true for one this key already has from an earlier approval, `addedByAgent` for one the agent
added itself (shown fixed, never sent back). `simulator` is the robot's own claim, for the badge
only. `existing` is `{active, expiresAt, scopes, notice}` when this key already has a delegation;
approving replaces it.

`{"step": "approve", "key", "req", "scopes": [...], "robots": [...], "ttl": <seconds>, "confirm": true}`
approves with the person's choices, through the same validation and transaction as the web page:
only requested scopes, only the person's robots, a `ttl` from the choices, and `confirm` true
(the "I ran this myself" box). Answer:
`{approved: true, delegateId, fingerprint, name, scopes: [{scope, title}], robots: [{robotId, name}], expiresAt}`.
`{"step": "decline", …}` changes nothing and answers `{approved: false}`.

Refusals are `{error, message}` with the page's message: `400 invalid_link`, `link_expired`,
`wrong_account` (the link names another account), `bad_request`, `confirm_required`, `bad_ttl`,
`no_scopes`; `403 too_many_agents`; `409 key_revoked` (with `revokedAt`; a revoked key is never
approved again), `key_other_account`, `robot_not_yours`; `429 rate_limited` (30 approvals per
person an hour, page and app together).

**Before sending an approval the app asks for Face ID, Touch ID or the passcode**
(LocalAuthentication `.deviceOwnerAuthentication`, a fresh context, no reuse). The relay cannot
verify that check; see [agent-delegation.md](agent-delegation.md#2b-consent-in-the-ios-app) for
why it is still required and what it does not cover. Send the approval once: on an unknown
outcome, read `GET /v1/app/delegations` rather than send it again.

Share calls answer `404 not_found` to anyone who does not own the robot (a person it is shared
with included), as for a robot that does not exist; `{userId}` is `gh:<numeric GitHub id>`.
Show the account from the lookup (name, username, joined year, a link to `https://github.com/<login>`)
and let the owner confirm before calling the share; do not share on the lookup alone.

Errors are JSON `{"error": "<code>"}` with 400, 401 (`invalid_assertion` + `detail`), 403, 404,
405, 409, 429, 502 or 503.

### 4. On the robot

`POST https://<hostname>/_connect/session` with `{"grant": "…"}` and the header
`Origin: https://<hostname>`. The agent answers with the `__Host-mc_session` cookie (12 hours);
`URLSession` keeps it. Send `Origin: https://<hostname>` on every changing request and on the
WebSocket upgrade: the agent refuses them without it. Everything else is the MowgliNext GUI's own
API (`/api/...`, `/api/mowglinext/multiplex`), as on the home network. Optional compression: add
`__mcz=1` to the WebSocket URL; each message is then one flag byte (1 = text, 2 = deflate) and the
payload, deflate-raw when flagged (`COMPRESSION_ZLIB` in Apple's Compression framework).

### What the app should do

- Create the key with `SecureEnclave.P256.Signing.PrivateKey`, access control
  `.privateKeyUsage` and `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, so it never leaves the
  phone and is not in backups; add `.userPresence` if opening a robot should need Face ID.
- Keep robot sessions out of backups and off disk: use a `URLSessionConfiguration.ephemeral`
  session (in-memory cookies) for robot traffic and get a fresh grant when the app starts.
- Use `ASWebAuthenticationSession` with the HTTPS callback, never an embedded web view, for
  sign-in.
- Treat `outcomeUnknown` on changing requests as the app already does: never replay them.

Devices unused for 180 days are signed out automatically. Request bodies are not covered by the
signature (method and URL are); TLS protects them, and a signed request works only once.

## Threat model

| Threat | What stops it |
|---|---|
| Another app on the phone pretends to be the Mowgli app | The callback is an HTTPS URL delivered only to apps listed in the relay's `apple-app-site-association` (associated domains, verified by Apple). With the free-team scheme callback this protection is gone and only the consent page and the Devices list remain (see that section). |
| The authorization code leaks (logs, a browser history, a shoulder) | It works once, for 60 seconds, only with the PKCE verifier and only with the device key whose thumbprint was bound at authorize time. |
| The phone's storage is copied (backup, malware reading files) | There is no token: the Secure Enclave key cannot be exported; signed requests live 60 s and work once. |
| A link tricks someone into approving a sign-in | With the HTTPS callback, the result goes to the genuine app on that person's own phone; the attacker gets nothing. With the free-team scheme callback this holds only if no malicious app is involved (see that section). Either way the consent page names the device, and the device appears under Devices. |
| A stolen device key, or someone holding the unlocked phone, approves an AI agent | Approval needs a consent link signed by the agent's own key for this account, valid 30 minutes, and every rule of the web page (agent-delegation.md, 2b); the app asks for Face ID or the passcode first. A device key alone can approve nothing. | The relay cannot verify the Face ID check (the device key signs every call without it). Whoever holds both the device key and an agent key with a fresh link for this account can approve it; it shows under AI agents, where it can be revoked. |
| Cross-site request to the consent form | Origin check on the POST; the page cannot be framed (`frame-ancestors 'none'`). |
| Open redirect through `redirect_uri` | Exact match against the relay's own callback URL. |
| A lost or sold phone | Sign it out under Devices on another device. That also signs everyone out of the robots its owner owns, which ends the robot sessions the app still had at each robot's next sync (within 3, at most 10 minutes; otherwise they would last up to 12 hours), cancels pending app sign-ins, and signs the person out of Mowgli Connect in every other browser, so the phone's own browser cannot sign the app in again. On robots the person only views, the owner can sign everyone out. A grant requested while the sign-out happens gets the old epoch or nothing, never the new one. Keys can also require Face ID or the passcode (app side). An admin removing the person deletes all their devices, and their robots drop them at the next sync. |
| A share call altered in transit (the body is not signed) | TLS protects it; the signed call works once. The relay re-looks the account up by id when it shares and the owner sees it first, so what is stored is GitHub's id and login, not the caller's text. |
| A guest's device calls the share routes | Owner-only: any other signed-in person gets `404`, as for an unknown robot (tested for guests, viewers, another owner and an owner the admin removed). |
| Replay of a signed request | Single-use `jti`, 60-second lifetime, method and URL bound. |
| A copy of the relay database | Devices hold only public keys and names; codes are stored as hashes and expire in 60 s. |
| Abuse of the endpoints | Sign-in needs an invited account or a robot shared with it (a guest, who cannot add robots); at most 10 devices and 5 open codes per person, both enforced in single statements; a wrong or made-up code writes nothing and does not use up the real one; the existing per-IP WAF rule covers the relay. |
| Relay or Cloudflare account compromised | Unchanged: they are the root of trust (SECURITY.md). |

What this adds to the attack surface: `/app/authorize` (behind the browser session), the AI-agent consent call (behind a device signature and an agent-signed link),
`/v1/app/token` (behind a one-time code, PKCE and a key signature) and the signed app API. The
agent, the tunnel and the egress lock are unchanged.

## Free Apple team: private-use scheme callback

A free Apple Personal Team cannot use associated domains, so the HTTPS callback is not possible.
For that case the relay also accepts exactly the callbacks listed in `APP_REDIRECT_URIS`, each of
the form `<bundle id>:/<path>` (RFC 8252 section 7.1) for a bundle id in `APP_IOS_APP_IDS`. The
hosted relay uses `garden.mowgli.prototypes:/connect/callback`. The app passes it as
`redirect_uri` both to `/app/authorize` and to `/v1/app/token` (a code works only with the
redirect URI it was issued for), and starts the session with
`ASWebAuthenticationSession(url:callback: .customScheme("garden.mowgli.prototypes"))`. The consent
page's CSP allows exactly that scheme as a form target, since the approval redirects to it.

What this variant gives up: iOS hands the callback to the authentication session that started the
sign-in, so another app cannot intercept the Mowgli app's own sign-in. But any app can start its
own session for the same scheme, and the relay cannot tell it apart. A malicious app on the phone
could therefore ask for a sign-in that the person approves on the consent page, thinking it is the
Mowgli app. That app can bring a key and a PKCE challenge made anywhere, so the device it gets
can then be used from anywhere: PKCE and the key binding prove that the same party finishes the
sign-in, not that it is the Mowgli app, a Secure Enclave key or the phone in your hand (security
review 12 reproduced this). What still protects you is the consent page (only approve a sign-in
you started yourself, in the Mowgli app, a moment ago) and the Devices list with Sign out, which
shows every device and its name. Outside `ASWebAuthenticationSession`, another app registered
for the same scheme could also catch or drop a callback; that cannot defeat PKCE or the key
binding, but it can make a sign-in fail. The app must therefore accept a callback only while a
sign-in it started is pending, only for the exact callback URI, and only with the `state` it sent
(RFC 8252 sections 8.9 and 8.10). Switch to the HTTPS callback, and remove the scheme from
`APP_REDIRECT_URIS`, as soon as the app is signed by a paid team (the mowgli-ios roadmap records
this follow-up).

## Configuration

| Variable | Meaning |
|---|---|
| `APP_IOS_APP_IDS` | comma list of `<TeamID>.<bundle id>` allowed to receive sign-ins. Empty or unset: the app API and `apple-app-site-association` answer 404. |
| `APP_REDIRECT_URIS` | optional comma list of private-use scheme callbacks, `<bundle id>:/<path>` for a bundle id above (see the free-team section). Anything else in it is ignored. |

The relay serves `/.well-known/apple-app-site-association` for these ids (`webcredentials`,
which an HTTPS `ASWebAuthenticationSession` callback requires, and `applinks` for `/app/callback`
and, with delegation on, for `/delegate/authorize` with a `key` and `req`, so tapping a consent
link on an iPhone opens the app; every other device, and an app without the associated domain,
keeps the web page). The app declares the associated domains `webcredentials:<relay host>` and
`applinks:<relay host>`. Check the current Apple documentation for
`ASWebAuthenticationSession.Callback.https` when building the app: this is the one part of the
flow the relay cannot test.
