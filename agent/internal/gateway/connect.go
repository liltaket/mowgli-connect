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
<link rel="stylesheet" href="/_connect/connect.css">
</head>
<body>
<header class="lawn"><span class="mark" aria-hidden="true"></span>Mowgli Connect</header>
<main>
<div class="spinner" id="spinner" aria-hidden="true"></div>
<h1 id="title">Opening your robot…</h1>
<p id="msg" role="status">Signing you in securely.</p>
<p id="back" hidden><a class="btn" href="{{RELAY}}">Back to Mowgli Connect</a></p>
</main>
<script src="/_connect/callback.js"></script>
</body>
</html>
`

const connectCSS = `:root{color-scheme:light dark;--bg:#f1f5ee;--fg:#142017;--muted:#4b5c4e;--line:#cbd8c6;--grass-d:#2f6b33;--grass-l:#3f8340;--signal:#f2c230}
@media (prefers-color-scheme:dark){:root{--bg:#101a12;--fg:#e7efe4;--muted:#a6b8a8;--line:#2a3a2d}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.lawn{display:flex;align-items:center;gap:.55rem;padding:1rem 16px;font-weight:700;color:#fff;background:repeating-linear-gradient(90deg,var(--grass-d) 0 3rem,var(--grass-l) 3rem 6rem)}
.mark{width:1.5rem;height:1.5rem;border-radius:.4rem;background:var(--signal);box-shadow:inset 0 0 0 .3rem rgba(0,0,0,.12)}
main{max-width:30rem;margin:0 auto;padding:4rem 16px;text-align:center}
h1{font-size:1.5rem;margin:1.5rem 0 .5rem}
p{color:var(--muted);margin:0 0 1rem}
.spinner{width:3rem;height:3rem;margin:0 auto;border-radius:50%;border:.35rem solid var(--line);border-top-color:var(--grass-l);animation:spin .9s linear infinite}
.spinner.failed{animation:none;border-color:var(--signal)}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:3s}}
.btn{display:inline-block;padding:.6rem 1rem;border-radius:.5rem;background:var(--signal);color:#1c1a08;font-weight:500;text-decoration:none}
.btn:focus-visible{outline:3px solid var(--grass-l);outline-offset:2px}
[hidden]{display:none}
`

// The grant travels in the URL fragment, so it never reaches Cloudflare, logs or the app.
const callbackJS = `(async () => {
  const msg = document.getElementById("msg");
  const fail = (title, text) => {
    document.getElementById("title").textContent = title;
    msg.textContent = text;
    document.getElementById("spinner").classList.add("failed");
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
	h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")

	switch {
	case r.URL.Path == "/_connect/healthz" && r.Method == http.MethodGet:
		w.WriteHeader(http.StatusNoContent) // tunnel self-check; reveals nothing
	case r.URL.Path == "/_connect/callback" && r.Method == http.MethodGet:
		h.Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, strings.Replace(callbackHTML, "{{RELAY}}", html.EscapeString(g.cfg.RelayOrigin+"/"), 1))
	case r.URL.Path == "/_connect/connect.css" && r.Method == http.MethodGet:
		h.Set("Content-Type", "text/css; charset=utf-8")
		io.WriteString(w, connectCSS)
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
