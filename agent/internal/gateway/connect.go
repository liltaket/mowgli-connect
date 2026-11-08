package gateway

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"io"
	"net/http"
)

const callbackHTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mowgli Connect</title>
<p id="msg">Connecting to your robot…</p>
<script src="/_connect/callback.js"></script>
`

// The grant travels in the URL fragment, so it never reaches Cloudflare, logs or the app.
const callbackJS = `(async () => {
  const msg = document.getElementById("msg");
  const grant = new URLSearchParams(location.hash.slice(1)).get("grant");
  history.replaceState(null, "", location.pathname);
  if (!grant) { msg.textContent = "Missing sign-in grant. Open this robot from Mowgli Connect again."; return; }
  try {
    const r = await fetch("/_connect/session", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant }),
    });
    if (r.ok) { location.replace("/"); return; }
    msg.textContent = "Sign-in was rejected (" + r.status + "). Open this robot from Mowgli Connect again.";
  } catch (e) {
    msg.textContent = "Could not reach the robot: " + e;
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
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")

	switch {
	case r.URL.Path == "/_connect/healthz" && r.Method == http.MethodGet:
		w.WriteHeader(http.StatusNoContent) // tunnel self-check; reveals nothing
	case r.URL.Path == "/_connect/callback" && r.Method == http.MethodGet:
		h.Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, callbackHTML)
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
			g.persistLocked()
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
