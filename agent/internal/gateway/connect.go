package gateway

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"strings"
)

// The sign-in page shown for a moment between the relay and the robot's own GUI. The relay
// link is filled in per gateway (escaped); everything else is static. No inline script or style:
// the CSP allows only same-origin files.
const callbackHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Opening your robot · Mowgli Connect</title>
<link rel="icon" href="/_connect/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/_connect/connect.css">
</head>
<body>
<header class="top"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect class="mark-tile" width="32" height="32" rx="8"/><path class="mark-path" d="M8.5 9.5h15v6.5h-15v6.5h10"/><circle class="mark-robot" cx="22.7" cy="22.5" r="2.3"/></svg>Mowgli Connect</header>
<main>
<svg class="lawn" id="lawn" viewBox="0 0 132 76" aria-hidden="true"><rect class="lawn-bed" width="132" height="76" rx="12"/><g transform="translate(14 14)"><path class="lawn-cut" d="M0 0h104v16H0v16h104v16H48"/><path class="lawn-line" d="M0 0h104v16H0v16h104v16H48"/><circle class="lawn-mower" r="5"/></g></svg>
<h1 id="title">Opening your robot…</h1>
<p id="msg" role="status">Signing you in to the mower's own app.</p>
<p id="back" hidden><a class="btn" href="{{RELAY}}">Back to Mowgli Connect</a></p>
</main>
<script src="/_connect/callback.js"></script>
</body>
</html>
`

// Same visual system as the relay and the project site: tinted paper, one grass-green accent,
// the mowing-path mark. Kept tiny; system fonts only.
const connectCSS = `:root{color-scheme:light dark;--paper:#fbfcfa;--ink:#18211b;--muted:#5b675f;--line:#d9e0da;--line-strong:#b9c4bb;--grass:#2f7d4a;--grass-deep:#266640;--on-grass:#fff;--amber:#b7791b;--focus:#1f5a35;--lawn:#d7eadc;--wash:#e6f2e9}
@media (prefers-color-scheme:dark){:root{--paper:#111613;--ink:#e8ede8;--muted:#a3ada5;--line:#2b342d;--line-strong:#3f4b42;--grass:#6cc98a;--grass-deep:#5bb97a;--on-grass:#0f1a13;--amber:#e0a54a;--focus:#b2e3c0;--lawn:#1d3424;--wash:#1b2a1f}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.top{display:flex;align-items:center;gap:.6rem;padding:14px 16px;font-weight:700;font-size:1.05rem;letter-spacing:-.01em;border-bottom:1px solid var(--line)}
.mark{width:24px;height:24px;flex:none}
.mark-tile{fill:var(--grass)}
.mark-path{fill:none;stroke:var(--on-grass);stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.mark-robot{fill:var(--on-grass)}
main{max-width:30rem;margin:0 auto;padding:5rem 16px 4rem;text-align:center}
h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.02em;margin:1.5rem 0 .5rem}
p{color:var(--muted);margin:0 0 1.25rem}
.lawn{display:block;width:132px;height:76px;margin:0 auto}
.lawn-bed{fill:var(--lawn)}
.lawn-cut{fill:none;stroke:var(--wash);stroke-width:14;stroke-linejoin:round}
.lawn-line{fill:none;stroke:var(--grass);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.lawn-mower{fill:var(--grass);offset-path:path("M0 0h104v16H0v16h104v16H48");offset-rotate:0deg;offset-distance:100%}
.lawn-cut,.lawn-line{stroke-dasharray:416}
@media (prefers-reduced-motion:no-preference){.lawn:not(.failed) .lawn-cut,.lawn:not(.failed) .lawn-line{animation:lawn 3s linear infinite both}.lawn:not(.failed) .lawn-mower{animation:mower 3s linear infinite both}}
@keyframes lawn{0%{stroke-dashoffset:416;opacity:1}80%,90%{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}
@keyframes mower{0%{offset-distance:0%}80%,100%{offset-distance:100%}}
@supports not (offset-path:path("M0 0")){.lawn-mower{display:none}}
.lawn.failed .lawn-line{stroke:var(--amber)}
.lawn.failed .lawn-mower{fill:var(--amber)}
.btn{display:inline-block;min-height:44px;padding:.6rem 1.1rem;border-radius:8px;background:var(--grass);color:var(--on-grass);font-weight:600;text-decoration:none}
.btn:hover{background:var(--grass-deep)}
.btn:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
[hidden]{display:none}
`

// The mowing-path mark (site/icon.svg), as the sign-in page's favicon.
const iconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2f7d4a"/><path d="M8.5 9.5h15v6.5h-15v6.5h10" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="22.7" cy="22.5" r="2.3" fill="#fff"/></svg>`

// The grant travels in the URL fragment, so it never reaches Cloudflare, logs or the app.
const callbackJS = `(async () => {
  const msg = document.getElementById("msg");
  const fail = (title, text) => {
    document.getElementById("title").textContent = title;
    msg.textContent = text;
    document.getElementById("lawn").classList.add("failed");
    document.getElementById("back").hidden = false;
  };
  const grant = new URLSearchParams(location.hash.slice(1)).get("grant");
  history.replaceState(null, "", location.pathname);
  if (!grant) { fail("This link has expired", "Open the robot from Mowgli Connect again."); return; }
  try {
    const r = await fetch("/_connect/session", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant }),
    });
    if (r.ok) { msg.textContent = "Loading the mower's app…"; location.replace("/"); return; }
    fail("Could not sign you in", "The sign-in link was not accepted (" + r.status + "). It is valid for one minute and works once; open the robot from Mowgli Connect again.");
  } catch (e) {
    fail("Could not reach the robot", "Check that it is on and online, then try again from Mowgli Connect.");
  }
})();
`

//go:embed ws.js
var wsShimJS string

func (g *Gateway) serveConnect(w http.ResponseWriter, r *http.Request, st State) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")

	switch {
	case r.URL.Path == "/_connect/healthz" && r.Method == http.MethodGet:
		w.WriteHeader(http.StatusNoContent) // tunnel self-check; reveals nothing
	case r.URL.Path == "/_connect/callback" && r.Method == http.MethodGet:
		h.Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, strings.Replace(callbackHTML, "{{RELAY}}", html.EscapeString(g.cfg.RelayOrigin+"/"), 1))
	case r.URL.Path == "/_connect/connect.css" && r.Method == http.MethodGet:
		h.Set("Content-Type", "text/css; charset=utf-8")
		io.WriteString(w, connectCSS)
	case r.URL.Path == "/_connect/icon.svg" && r.Method == http.MethodGet:
		h.Set("Content-Type", "image/svg+xml")
		h.Set("Cache-Control", "public, max-age=86400")
		io.WriteString(w, iconSVG)
	case r.URL.Path == "/_connect/callback.js" && r.Method == http.MethodGet:
		h.Set("Content-Type", "text/javascript; charset=utf-8")
		io.WriteString(w, callbackJS)
	case r.URL.Path == "/_connect/ws.js" && r.Method == http.MethodGet:
		h.Set("Content-Type", "text/javascript; charset=utf-8")
		io.WriteString(w, wsShimJS)
	case r.URL.Path == "/_connect/session" && r.Method == http.MethodPost:
		g.handleSession(w, r, st)
	case r.URL.Path == "/_connect/logout" && r.Method == http.MethodPost:
		if !sameOrigin(r, st.Hostname) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad_origin"})
			return
		}
		if c, err := r.Cookie(CookieName); err == nil {
			key := sha256.Sum256([]byte(c.Value))
			g.mu.Lock()
			delete(g.sessions, key)
			_ = g.persistLocked()
			g.mu.Unlock()
		}
		http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", MaxAge: -1, Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/_connect/whoami" && r.Method == http.MethodGet:
		s := g.sessionFrom(r)
		if s == nil || g.effectiveRole(s) == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated", "login": g.loginURL()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"sub": s.sub, "name": s.name, "role": g.effectiveRole(s), "expiresAt": s.expires.Unix()})
	default:
		http.NotFound(w, r)
	}
}

func (g *Gateway) handleSession(w http.ResponseWriter, r *http.Request, st State) {
	if !sameOrigin(r, st.Hostname) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad_origin"})
		return
	}
	var body struct {
		Grant string `json:"grant"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil || body.Grant == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request"})
		return
	}
	tok, s, err := g.redeemGrant(body.Grant)
	if err != nil {
		g.cfg.Logger.Warn("grant rejected", "reason", err.Error())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "grant_rejected"})
		return
	}
	g.cfg.Logger.Info("session created", "sub", s.sub, "role", s.role)
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: tok, Path: "/", Expires: s.expires, MaxAge: int(SessionTTL.Seconds()),
		Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	w.WriteHeader(http.StatusNoContent)
}
