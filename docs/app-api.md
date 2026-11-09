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
4. **Same rules as the web.** Invitations, robot limits, owner/viewer roles, admin removal and
   "Sign everyone out" apply to the app exactly as to the browser.

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
| `GET /v1/app/me` | `{login, name, robotLimit, robots}` |
| `GET /v1/app/robots` | `{robots: [{robotId, name, hostname, role, online, joystick, updateAvailable}]}` |
| `POST /v1/app/robots/{robotId}/grant` | `{grant, hostname, expiresAt}`; `503 {"error":"robot_offline"}` if its tunnel is down |
| `POST /v1/app/claim` | body `{code, label?, step: "preview"\|"confirm"}`: preview `{robotId, name, hostname}`, confirm `{robotId, hostname}`; same limits and guess budget as the web |
| `POST /v1/app/sign-out` | deletes this device and, in the same transaction, signs everyone out of the robots its owner owns (their session epoch goes up, so robot sessions and unused grants from before stop working at the robot's next successful sync: normally within `MC_POLL_INTERVAL`, 3 minutes, and at the latest after `MC_MAX_STALE`, 10 minutes, when the robot stops accepting anything until it syncs); pending sign-ins of that key are cancelled; robots the person only views are not touched. A second call answers 401 `unknown_device` |

Errors are JSON `{"error": "<code>"}` with 400, 401 (`invalid_assertion` + `detail`), 403, 404,
409, 429 or 503.

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
| Cross-site request to the consent form | Origin check on the POST; the page cannot be framed (`frame-ancestors 'none'`). |
| Open redirect through `redirect_uri` | Exact match against the relay's own callback URL. |
| A lost or sold phone | Sign it out under Devices on another device. That also signs everyone out of the robots its owner owns, which ends the robot sessions the app still had at each robot's next sync (within 3, at most 10 minutes; otherwise they would last up to 12 hours), cancels pending app sign-ins, and signs the person out of Mowgli Connect in every other browser, so the phone's own browser cannot sign the app in again. On robots the person only views, the owner can sign everyone out. A grant requested while the sign-out happens gets the old epoch or nothing, never the new one. Keys can also require Face ID or the passcode (app side). An admin removing the person deletes all their devices, and their robots drop them at the next sync. |
| Replay of a signed request | Single-use `jti`, 60-second lifetime, method and URL bound. |
| A copy of the relay database | Devices hold only public keys and names; codes are stored as hashes and expire in 60 s. |
| Abuse of the endpoints | Sign-in needs an invited account; at most 10 devices and 5 open codes per person, both enforced in single statements; a wrong or made-up code writes nothing and does not use up the real one; the existing per-IP WAF rule covers the relay. |
| Relay or Cloudflare account compromised | Unchanged: they are the root of trust (SECURITY.md). |

What this adds to the attack surface: `/app/authorize` (behind the browser session),
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
only). The app declares the associated domains `webcredentials:<relay host>` and
`applinks:<relay host>`. Check the current Apple documentation for
`ASWebAuthenticationSession.Callback.https` when building the app: this is the one part of the
flow the relay cannot test.
