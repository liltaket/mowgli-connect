# Native app API (iOS)

Status: designed 2026-11-08, implemented in the relay, **off until configured** (`APP_IOS_APP_IDS`).
This is the contract a native app (the Mowgli Next iOS app) uses to sign in to Mowgli Connect, list
its robots and open them. The robot side does not change: the app ends up with the same 60-second
grant and the same session on the robot as a browser does.

## Design goals

1. **No bearer secrets on the phone.** The app's identity is a P-256 key created in the Secure
   Enclave, which cannot be copied out. Every API call is signed with it. A backup, a log or a
   network capture of the phone holds nothing that can be replayed for more than a minute.
2. **Only the genuine app can sign in.** The sign-in result comes back on an HTTPS URL of the
   relay that iOS hands only to apps the relay names in its `apple-app-site-association` file
   (Team ID + bundle ID). Another app on the phone cannot receive it.
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
| `POST /v1/app/sign-out` | deletes this device |

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

## Threat model

| Threat | What stops it |
|---|---|
| Another app on the phone pretends to be the Mowgli app | The callback is an HTTPS URL delivered only to apps listed in the relay's `apple-app-site-association` (associated domains, verified by Apple). |
| The authorization code leaks (logs, a browser history, a shoulder) | It works once, for 60 seconds, only with the PKCE verifier and only with the device key whose thumbprint was bound at authorize time. |
| The phone's storage is copied (backup, malware reading files) | There is no token: the Secure Enclave key cannot be exported; signed requests live 60 s and work once. |
| A link tricks someone into approving a sign-in | The result goes to the genuine app on that person's own phone; the attacker gets nothing. The consent page names the device, and the device appears under Devices. |
| Cross-site request to the consent form | Origin check on the POST; the page cannot be framed (`frame-ancestors 'none'`). |
| Open redirect through `redirect_uri` | Exact match against the relay's own callback URL. |
| A lost or sold phone | Sign it out under Devices; keys can also require Face ID or the passcode for use (app side). An admin removing the person deletes all their devices. |
| Replay of a signed request | Single-use `jti`, 60-second lifetime, method and URL bound. |
| A copy of the relay database | Devices hold only public keys and names; codes are stored as hashes and expire in 60 s. |
| Abuse of the endpoints | Sign-in needs an invited account; at most 10 devices and 5 open codes per person; the existing per-IP WAF rule covers the relay. |
| Relay or Cloudflare account compromised | Unchanged: they are the root of trust (SECURITY.md). |

What this adds to the attack surface: `/app/authorize` (behind the browser session),
`/v1/app/token` (behind a one-time code, PKCE and a key signature) and the signed app API. The
agent, the tunnel and the egress lock are unchanged.

## Configuration

| Variable | Meaning |
|---|---|
| `APP_IOS_APP_IDS` | comma list of `<TeamID>.<bundle id>` allowed to receive sign-ins. Empty or unset: the app API and `apple-app-site-association` answer 404. |

The relay serves `/.well-known/apple-app-site-association` for these ids (`webcredentials`,
which an HTTPS `ASWebAuthenticationSession` callback requires, and `applinks` for `/app/callback`
only). The app declares the associated domains `webcredentials:<relay host>` and
`applinks:<relay host>`. Check the current Apple documentation for
`ASWebAuthenticationSession.Callback.https` when building the app: this is the one part of the
flow the relay cannot test.
