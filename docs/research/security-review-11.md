# Mowgli Connect security review 11: the native app API

Reviewed 2026-11-08: `git diff 2724896 a588ed9`, the native iOS app API in the relay
([docs/app-api.md](../app-api.md)): consent page, PKCE, one-time codes bound to a Secure Enclave
key, ES256-signed calls. Two independent reviews: GPT-6.1 Sol against RFC 8252, RFC 7636,
RFC 7638 and JWS/ECDSA pitfalls, and Claude Opus 5.5 from attacker positions (malicious app on
the phone, phishing links, a leaked code or request, a malicious invited user, crypto edge cases,
regressions, DoS). Both reproduced their findings with throwaway tests; the lead checked each.

Neither found a Critical or High issue. Opus could not build any chain that gets a device for
someone else's account without that person's own approval plus a leaked callback URL or their
GitHub password. Both confirmed: exact redirect matching, safe login return, S256-only PKCE,
code-to-key binding with proof of possession, Origin-checked and unframeable consent, correct
RFC 7638 thumbprints, rejection of off-curve and non-canonical keys, strict ES256 assertion checks,
per-call access checks, membership-bound grants, and no regression in the browser, admin, robot or
agent flows. Sol confirmed the Apple assumptions (HTTPS callbacks need iOS 17.4 and an associated
domain; `webcredentials` is the relevant service) from Apple's documentation, not on a device.

## Findings and status

| # | Finding | Severity | Found by | Status |
|---|---|---|---|---|
| 1 | `POST /v1/app/token` wrote a replay record before checking the code, so anyone could make the relay write to D1 for free (about 50k requests would use up the daily free writes). | Medium | both | **Fixed.** The code is consumed first, in one statement that also requires the right verifier and key; a wrong or made-up code writes nothing. |
| 2 | Signing a device out did not end robot sessions the app already had (up to 12 hours). | Medium (Sol), Low (Opus) | both | **Fixed** for robots the person owns: signing a device out also signs everyone out of them. On robots they only view, the owner can do it; documented. |
| 3 | Concurrent exchanges could exceed the 10-device limit (9 became 14). | Low | both | **Fixed.** Limit and insert are one statement. |
| 4 | Two people exchanging codes for the same key at once both got success, the second with the wrong account. | Low | Sol | **Fixed.** The result of the insert is checked; the loser gets 409. |
| 5 | Someone who saw a code could spoil the real sign-in with a wrong verifier. | Low (Sol), Info (Opus) | both | **Fixed** by 1: a failed attempt no longer uses the code up. |
| 6 | "No bearer secrets on the phone" overstated it: the robot session cookie is a 12-hour bearer cookie in `URLSession`; devices never expired. | Low | both | **Documented and fixed.** The doc now says so and tells the app to use ephemeral cookie storage; devices unused for 180 days are signed out. |
| 7 | Phishing helpers: the attacker chooses the device name (zero-width and bidi characters were kept), and the callback page did not warn against sharing its address. | Low | Opus | **Fixed.** Such characters are stripped from all names; the callback page warns; the consent page says to cancel if the link came from someone. |
| 8 | "Only the genuine app can sign in" holds only for the system authentication session; the relay cannot tell which app or key type it talks to. | Info | both | **Documented**; App Attest is a possible later addition. |
| 9 | The consent page sent two `Referrer-Policy` values, so the form POST relied on `Sec-Fetch-Site`. | Info | Opus | **Fixed.** One `same-origin` policy on the consent page; `no-referrer` only on the callback page. |
| 10 | ECDSA high-s signatures are accepted; request bodies are not signed. | Info | Opus | **Accepted**: replay protection keys on the signed `jti`, and bodies are protected by TLS; documented. |

Regression tests: `relay/test/app.test.ts` (sections "review 11").
