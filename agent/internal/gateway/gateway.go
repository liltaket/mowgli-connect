// Package gateway is the authenticating reverse proxy that sits between cloudflared and the
// local app. It is the authorization boundary: the tunnel hostname is public.
package gateway

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"mowgli-connect/agent/internal/jws"
)

const (
	CookieName     = "__Host-mc_session"
	SessionTTL     = 12 * time.Hour
	GrantMaxTTL    = 60 * time.Second
	ClockSkew      = 30 * time.Second
	maxSessions    = 1024
	maxGrantIDs    = 4096 // consumed grants remembered at once (each for ~90 s)
	reservedPrefix = "/_connect/"
)

// State is the robot's authorization snapshot from the relay (GET /v1/robots/self).
type State struct {
	Status    string // unclaimed | claimed | revoked
	Hostname  string
	RelayKeys map[string]ed25519.PublicKey
	Epoch     int64
	Members   map[string]string // userId -> role
}

type Config struct {
	RelayOrigin  string // exact grant issuer, e.g. https://connect.example.com
	RobotID      string
	Upstream     *url.URL // e.g. http://127.0.0.1:4006
	Policy       Policy
	MaxBodyBytes int64
	// WSCompression injects /_connect/ws.js into HTML pages so the app's WebSockets receive
	// compressed messages (Cloudflare strips permessage-deflate). See wsopt.go.
	WSCompression bool
	// Throttle caps how often each topic is relayed on the WebSocket at ThrottlePath
	// (MessagePack {topic, data} frames, e.g. the Mowgli multiplex socket).
	ThrottlePath string
	Throttle     map[string]time.Duration
	// MaxStale bounds how long the last relay snapshot may authorize anything. Past it (relay
	// unreachable), all sessions and grants are rejected so revocations cannot be outwaited.
	// Guard, if set, refuses requests that would cut off remote access (see ContainerGuard).
	Guard interface {
		Denies(method, path string) bool
	}
	MaxStale time.Duration
	// SessionFile, if set, keeps sessions across agent restarts (only token hashes are stored).
	SessionFile string
	// Resync, if set, asks for an immediate relay sync and waits for it. It is called (at most
	// every resyncMinGap) when a correctly signed grant names a newer epoch or an unknown
	// member, so the agent can poll the relay rarely and still admit new members at once.
	Resync func()
	Logger *slog.Logger
	Now    func() time.Time
}

type session struct {
	key             [32]byte // SHA-256 of the cookie value; the sessions map key
	sub, name, role string
	epoch           int64
	expires         time.Time
}

type Gateway struct {
	cfg   Config
	start time.Time
	// strictStart: consumed grants of the previous run are unknown (no, unreadable or
	// overfull session file), so grants issued around startup are refused instead of risking a
	// replay; only grants issued after start + ClockSkew are accepted.
	strictStart bool
	proxy       *httputil.ReverseProxy

	mu        sync.Mutex
	state     State
	lastFresh time.Time // last successful relay sync; zero until the first one
	sessions  map[[32]byte]*session
	jtis      map[string]time.Time
	resynced  time.Time
}

const resyncMinGap = 10 * time.Second

func New(cfg Config) *Gateway {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Policy == nil {
		cfg.Policy = GenericPolicy{}
	}
	if cfg.MaxBodyBytes == 0 {
		cfg.MaxBodyBytes = 64 << 20
	}
	cfg.RelayOrigin = strings.TrimRight(cfg.RelayOrigin, "/")
	g := &Gateway{
		cfg:      cfg,
		start:    cfg.Now(),
		sessions: map[[32]byte]*session{},
		jtis:     map[string]time.Time{},
	}
	g.loadSessions()
	g.proxy = &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(cfg.Upstream)
			pr.Out.Host = pr.In.Host // the GUI's WebSocket check compares Origin with Host
			setForwarded(pr.Out.Header, pr.In)
			if cfg.WSCompression && wantsHTML(pr.In) {
				pr.Out.Header.Del("Accept-Encoding") // plain HTML, so the shim can be injected
			}
		},
		FlushInterval: 50 * time.Millisecond,
		ModifyResponse: func(resp *http.Response) error {
			hardenResponse(resp.Header)
			privateCache(resp.Header)
			if cfg.WSCompression && wantsHTML(resp.Request) {
				if err := injectShim(resp); err != nil {
					return err
				}
			}
			gzipResponse(resp)
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
				return
			}
			cfg.Logger.Warn("upstream error", "path", r.URL.Path, "err", err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream_unavailable"})
		},
	}
	return g
}

// UpdateState applies a new relay snapshot and drops sessions it no longer authorizes.
func (g *Gateway) UpdateState(s State) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.state = s
	g.purgeLocked()
}

// purgeLocked deletes sessions the current state rejects. Staleness is deliberately not a
// reason: a stale snapshot suspends sessions until the next successful sync, it does not end them.
func (g *Gateway) purgeLocked() {
	changed := false
	for k, sess := range g.sessions {
		if !g.authorizedLocked(sess) {
			delete(g.sessions, k)
			changed = true
		}
	}
	if changed {
		_ = g.persistLocked()
	}
}

// MarkFresh records a successful relay sync (the state passed to UpdateState is current).
func (g *Gateway) MarkFresh() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.lastFresh = g.cfg.Now()
}

func (g *Gateway) freshLocked() bool {
	return g.cfg.MaxStale <= 0 || (!g.lastFresh.IsZero() && g.cfg.Now().Sub(g.lastFresh) <= g.cfg.MaxStale)
}

func (g *Gateway) validLocked(s *session) bool {
	return g.freshLocked() && g.authorizedLocked(s)
}

func (g *Gateway) authorizedLocked(s *session) bool {
	if g.state.Status != "claimed" || s.epoch != g.state.Epoch || !g.cfg.Now().Before(s.expires) {
		return false
	}
	return minRole(s.role, g.state.Members[s.sub]) != ""
}

// socketAllowed decides whether an open WebSocket may keep running: its session must still
// be registered (not logged out or purged) and valid, and the route must still be allowed for
// the session's current role (a downgrade can remove access to owner-only sockets).
func (g *Gateway) socketAllowed(s *session, method, path string) bool {
	g.mu.Lock()
	role := ""
	if g.sessions[s.key] == s && g.validLocked(s) {
		role = minRole(s.role, g.state.Members[s.sub])
	}
	g.mu.Unlock()
	return role != "" && g.cfg.Policy.Allow(role, method, path, true)
}

// effectiveRole is the session role capped by the user's current membership ("" = invalid).
func (g *Gateway) effectiveRole(s *session) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.validLocked(s) {
		return ""
	}
	return minRole(s.role, g.state.Members[s.sub])
}

func (g *Gateway) snapshot() State {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.state
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	st := g.snapshot()
	if st.Status != "claimed" || st.Hostname == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "robot_not_paired"})
		return
	}
	if !strings.EqualFold(r.Host, st.Hostname) {
		http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
		return
	}
	w.Header().Set("Strict-Transport-Security", "max-age=31536000")
	if !canonicalPath(r.URL) {
		http.Error(w, "non-canonical path", http.StatusBadRequest)
		return
	}
	if strings.HasPrefix(r.URL.Path, reservedPrefix) {
		g.serveConnect(w, r, st)
		return
	}

	sess := g.sessionFrom(r)
	role := ""
	if sess != nil {
		role = g.effectiveRole(sess)
	}
	isWS := websocket.IsWebSocketUpgrade(r)
	if role == "" {
		if r.Method == http.MethodGet && !isWS && strings.Contains(r.Header.Get("Accept"), "text/html") {
			http.Redirect(w, r, g.loginURL(), http.StatusFound)
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthenticated", "login": g.loginURL()})
		return
	}
	if (isWS || !safeMethod(r.Method)) && !sameOrigin(r, st.Hostname) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad_origin"})
		return
	}
	if !g.cfg.Policy.Allow(role, r.Method, r.URL.Path, isWS) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	if g.cfg.Guard != nil && g.cfg.Guard.Denies(r.Method, r.URL.Path) {
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "Stopping this container remotely would cut off remote access until someone restarts it at the robot. Restart it instead, or stop it at home.",
		})
		return
	}
	stripSessionCookie(r)
	if isWS {
		g.proxyWebSocket(w, r, sess)
		return
	}
	if r.ContentLength > g.cfg.MaxBodyBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "body_too_large"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, g.cfg.MaxBodyBytes)
	g.proxy.ServeHTTP(w, r)
}

func (g *Gateway) loginURL() string {
	return g.cfg.RelayOrigin + "/open/" + url.PathEscape(g.cfg.RobotID)
}

func (g *Gateway) sessionFrom(r *http.Request) *session {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return nil
	}
	key := sha256.Sum256([]byte(c.Value))
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.sessions[key]
}

// --- grant verification ---------------------------------------------------------------

type grantClaims struct {
	Iss   string `json:"iss"`
	Aud   string `json:"aud"`
	Sub   string `json:"sub"`
	Name  string `json:"name"`
	Role  string `json:"role"`
	Epoch int64  `json:"epoch"`
	Iat   int64  `json:"iat"`
	Exp   int64  `json:"exp"`
	Jti   string `json:"jti"`
}

type grantError string

func (e grantError) Error() string { return string(e) }

// redeemGrant verifies a relay grant and, on success, creates a session and returns its token.
func (g *Gateway) redeemGrant(token string) (string, *session, error) {
	g.mu.Lock()
	st, fresh := g.state, g.freshLocked()
	g.mu.Unlock()
	if !fresh {
		return "", nil, grantError("relay state stale")
	}
	var c grantClaims
	_, err := jws.Verify(token, "mc-grant+jwt", func(h jws.Header) (ed25519.PublicKey, bool) {
		k, ok := st.RelayKeys[h.Kid]
		return k, ok && h.Kid != ""
	}, &c)
	if err != nil {
		return "", nil, err
	}
	now := g.cfg.Now()
	iat, exp := time.Unix(c.Iat, 0), time.Unix(c.Exp, 0)
	switch {
	case c.Iss != g.cfg.RelayOrigin:
		return "", nil, grantError("wrong issuer")
	case c.Aud != "mc-robot:"+g.cfg.RobotID:
		return "", nil, grantError("wrong audience")
	case c.Sub == "" || len(c.Jti) < 22: // >= 128 bits, base64url (docs/protocol.md)
		return "", nil, grantError("missing claims")
	case exp.Sub(iat) > GrantMaxTTL || !exp.After(iat):
		return "", nil, grantError("bad lifetime")
	case now.After(exp.Add(ClockSkew)) || iat.After(now.Add(ClockSkew)):
		return "", nil, grantError("expired or not yet valid")
	case iat.Before(g.start.Add(-ClockSkew)) || (g.strictStart && !iat.After(g.start.Add(ClockSkew))):
		return "", nil, grantError("issued before agent start")
	}
	if (c.Epoch > st.Epoch || st.Members[c.Sub] == "") && g.resync() {
		g.mu.Lock()
		st.Epoch, st.Members = g.state.Epoch, g.state.Members
		g.mu.Unlock()
	}
	if c.Epoch != st.Epoch {
		return "", nil, grantError("stale epoch")
	}
	role := minRole(c.Role, st.Members[c.Sub])
	if role == "" {
		return "", nil, grantError("not a member")
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	tok := base64.RawURLEncoding.EncodeToString(raw)
	s := &session{key: sha256.Sum256([]byte(tok)), sub: c.Sub, name: c.Name, role: role, epoch: c.Epoch, expires: now.Add(SessionTTL)}

	g.mu.Lock()
	defer g.mu.Unlock()
	for j, e := range g.jtis {
		if now.After(e) {
			delete(g.jtis, j)
		}
	}
	if _, used := g.jtis[c.Jti]; used {
		return "", nil, grantError("grant replayed")
	}
	if len(g.jtis) >= maxGrantIDs {
		return "", nil, grantError("too many recent grants")
	}
	g.jtis[c.Jti] = exp.Add(ClockSkew)
	g.purgeLocked()
	if len(g.sessions) >= maxSessions {
		return "", nil, grantError("too many sessions")
	}
	g.sessions[s.key] = s
	// The consumed grant must be on disk before the session is handed out, or a restart could
	// accept the same grant again.
	if err := g.persistLocked(); err != nil {
		delete(g.sessions, s.key)
		return "", nil, grantError("cannot record session: " + err.Error())
	}
	return tok, s, nil
}

// resync runs cfg.Resync unless it ran recently; it reports whether it ran.
func (g *Gateway) resync() bool {
	if g.cfg.Resync == nil {
		return false
	}
	g.mu.Lock()
	now := g.cfg.Now()
	if !g.resynced.IsZero() && now.Sub(g.resynced) < resyncMinGap {
		g.mu.Unlock()
		return false
	}
	g.resynced = now
	g.mu.Unlock()
	g.cfg.Resync()
	return true
}

// --- helpers --------------------------------------------------------------------------

// canonicalPath rejects paths that a downstream router might normalize differently from
// the policy check (dot segments, duplicate slashes, encoded slashes).
func canonicalPath(u *url.URL) bool {
	p := u.Path
	if p == "" || p[0] != '/' || strings.Contains(p, "//") || strings.Contains(p, "\\") {
		return false
	}
	if u.RawPath != "" && strings.Contains(strings.ToLower(u.RawPath), "%2f") {
		return false
	}
	clean := path.Clean(p)
	if strings.HasSuffix(p, "/") && clean != "/" {
		clean += "/"
	}
	return clean == p
}

// sameOrigin is the CSRF check. Browsers send "Origin: null" for same-origin POSTs under some
// referrer policies, so that is accepted only with the browser-set Sec-Fetch-Site: same-origin.
func sameOrigin(r *http.Request, host string) bool {
	o := r.Header.Get("Origin")
	if strings.EqualFold(o, "https://"+host) {
		return true
	}
	return (o == "" || o == "null") && r.Header.Get("Sec-Fetch-Site") == "same-origin" && !websocket.IsWebSocketUpgrade(r)
}

func stripSessionCookie(r *http.Request) {
	cookies := r.Cookies()
	r.Header.Del("Cookie")
	for _, c := range cookies {
		if c.Name != CookieName {
			r.AddCookie(c)
		}
	}
}

func setForwarded(h http.Header, in *http.Request) {
	if ip := in.Header.Get("Cf-Connecting-Ip"); net.ParseIP(ip) != nil {
		h.Set("X-Forwarded-For", ip)
	}
	h.Set("X-Forwarded-Proto", "https")
	h.Set("X-Forwarded-Host", in.Host)
}

func hardenResponse(h http.Header) {
	// The app must not be able to plant or overwrite the gateway session cookie.
	if sc := h.Values("Set-Cookie"); len(sc) > 0 {
		h.Del("Set-Cookie")
		for _, v := range sc {
			name, _, _ := strings.Cut(v, "=")
			if strings.TrimSpace(name) != CookieName { // browsers trim the name, so must we
				h.Add("Set-Cookie", v)
			}
		}
	}
	if h.Get("X-Frame-Options") == "" {
		h.Set("X-Frame-Options", "DENY")
	}
	if h.Get("X-Content-Type-Options") == "" {
		h.Set("X-Content-Type-Options", "nosniff")
	}
	if h.Get("Referrer-Policy") == "" {
		h.Set("Referrer-Policy", "same-origin")
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
