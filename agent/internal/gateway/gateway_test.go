package gateway

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"mowgli-connect/agent/internal/jws"
)

const (
	testHost  = "abcdefghijklmnop.robots.example.com"
	testRelay = "https://connect.example.com"
	testRobot = "abcdefghijklmnop"
)

// fakeGUI mimics the MowgliNext backend parts that matter to the proxy: an Origin==Host
// WebSocket check (gui/pkg/api/mowglinext.go), SSE streaming and request echoing.
func fakeGUI(t *testing.T) *httptest.Server {
	up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool {
		o, err := url.Parse(r.Header.Get("Origin"))
		return err == nil && o.Host == r.Host
	}}
	mux := http.NewServeMux()
	echoWS := func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			typ, msg, err := c.ReadMessage()
			if err != nil {
				return
			}
			_ = c.WriteMessage(typ, append([]byte("echo:"), msg...))
		}
	}
	mux.HandleFunc("/api/mowglinext/multiplex", echoWS)
	mux.HandleFunc("/api/containers/", echoWS)         // owner-only log socket
	mux.HandleFunc("/api/mowglinext/publish/", echoWS) // joystick: stays open like the real one
	mux.HandleFunc("/api/setup/flashBoard", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 2; i++ {
			io.WriteString(w, "event: stage\ndata: x\n\n")
			w.(http.Flusher).Flush()
			time.Sleep(100 * time.Millisecond)
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "planted"})
		body, _ := io.ReadAll(r.Body)
		json.NewEncoder(w).Encode(map[string]string{
			"host": r.Host, "cookie": r.Header.Get("Cookie"), "path": r.URL.Path, "method": r.Method,
			"xfp": r.Header.Get("X-Forwarded-Proto"), "body": string(body),
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type fixture struct {
	t     *testing.T
	gw    *Gateway
	srv   *httptest.Server
	key   ed25519.PrivateKey
	state State
	now   time.Time
}

func newFixture(t *testing.T, policy Policy) *fixture {
	gui := fakeGUI(t)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	up, _ := url.Parse(gui.URL)
	f := &fixture{t: t, key: priv, now: time.Now()}
	f.gw = New(Config{RelayOrigin: testRelay, RobotID: testRobot, Upstream: up, Policy: policy,
		WSCompression: true, MaxStale: time.Hour, Now: func() time.Time { return f.now }})
	f.state = State{Status: "claimed", Hostname: testHost, Epoch: 3,
		RelayKeys: map[string]ed25519.PublicKey{"k1": pub},
		Members:   map[string]string{"gh:1": RoleOwner, "gh:2": RoleViewer, "gh:3": RoleOperator}}
	f.gw.UpdateState(f.state)
	f.gw.MarkFresh()
	f.srv = httptest.NewServer(f.gw)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fixture) grant(mut func(map[string]any)) string {
	jti := make([]byte, 16)
	rand.Read(jti)
	c := map[string]any{"iss": testRelay, "aud": "mc-robot:" + testRobot, "sub": "gh:1", "name": "Bruno",
		"role": RoleOwner, "epoch": 3, "iat": f.now.Unix(), "exp": f.now.Unix() + 60,
		"jti": base64.RawURLEncoding.EncodeToString(jti)}
	if mut != nil {
		mut(c)
	}
	tok, err := jws.Sign(f.key, "mc-grant+jwt", "k1", c)
	if err != nil {
		f.t.Fatal(err)
	}
	return tok
}

func (f *fixture) req(method, path string, hdr map[string]string, body string) *http.Response {
	r, _ := http.NewRequest(method, f.srv.URL+path, strings.NewReader(body))
	r.Host = testHost
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	resp, err := http.DefaultTransport.RoundTrip(r)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func (f *fixture) login(grant string) (string, int) {
	resp := f.req("POST", "/_connect/session", map[string]string{"Origin": "https://" + testHost, "Content-Type": "application/json"},
		`{"grant":"`+grant+`"}`)
	for _, c := range resp.Cookies() {
		if c.Name == CookieName && c.Value != "" {
			if !c.Secure || !c.HttpOnly || c.Path != "/" || c.Domain != "" {
				f.t.Fatalf("session cookie attributes not __Host- safe: %+v", c)
			}
			return c.Value, resp.StatusCode
		}
	}
	return "", resp.StatusCode
}

func cookie(tok string) string { return CookieName + "=" + tok }

func TestUnauthenticated(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	r := f.req("GET", "/", map[string]string{"Accept": "text/html"}, "")
	if r.StatusCode != 302 || r.Header.Get("Location") != testRelay+"/open/"+testRobot {
		t.Fatalf("html: got %d %q", r.StatusCode, r.Header.Get("Location"))
	}
	if r := f.req("GET", "/api/system/info", nil, ""); r.StatusCode != 401 {
		t.Fatalf("api: got %d", r.StatusCode)
	}
	if r := f.req("POST", "/api/system/reboot", map[string]string{"Origin": "https://" + testHost}, ""); r.StatusCode != 401 {
		t.Fatalf("post: got %d", r.StatusCode)
	}
	if r := f.req("GET", "/", map[string]string{"Cookie": cookie("forged")}, ""); r.StatusCode != 401 {
		t.Fatalf("forged cookie: got %d", r.StatusCode)
	}
}

func TestHostAndPairingChecks(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	r, _ := http.NewRequest("GET", f.srv.URL+"/", nil)
	r.Host = "other.robots.example.com"
	resp, _ := http.DefaultTransport.RoundTrip(r)
	if resp.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("wrong host: got %d", resp.StatusCode)
	}
	f.gw.UpdateState(State{Status: "unclaimed"})
	if r := f.req("GET", "/", nil, ""); r.StatusCode != 503 {
		t.Fatalf("unclaimed: got %d", r.StatusCode)
	}
}

func TestGrantValidation(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	cases := map[string]string{
		"wrong aud":    f.grant(func(c map[string]any) { c["aud"] = "mc-robot:zzzzzzzzzzzzzzzz" }),
		"wrong iss":    f.grant(func(c map[string]any) { c["iss"] = "https://evil.example.com" }),
		"expired":      f.grant(func(c map[string]any) { c["iat"] = f.now.Unix() - 200; c["exp"] = f.now.Unix() - 140 }),
		"too long":     f.grant(func(c map[string]any) { c["exp"] = f.now.Unix() + 3600 }),
		"stale epoch":  f.grant(func(c map[string]any) { c["epoch"] = 2 }),
		"non member":   f.grant(func(c map[string]any) { c["sub"] = "gh:999" }),
		"short jti":    f.grant(func(c map[string]any) { c["jti"] = "only-21-characters-xx" }),
		"before start": f.grant(func(c map[string]any) { c["iat"] = f.now.Unix() - 50; c["exp"] = f.now.Unix() + 5 }),
	}
	f.now = f.now.Add(10 * time.Second) // agent started 10 s before "now" for the before-start case
	f.gw.start = f.now.Add(-10 * time.Second)
	for name, g := range cases {
		if tok, status := f.login(g); tok != "" || status != 401 {
			t.Errorf("%s: accepted (status %d)", name, status)
		}
	}
	bad, _ := jws.Sign(otherKey, "mc-grant+jwt", "k1", map[string]any{"iss": testRelay})
	if tok, _ := f.login(bad); tok != "" {
		t.Error("foreign key accepted")
	}

	g := f.grant(nil)
	tok, status := f.login(g)
	if tok == "" || status != 204 {
		t.Fatalf("valid grant rejected: %d", status)
	}
	if tok2, _ := f.login(g); tok2 != "" {
		t.Fatal("replayed grant accepted")
	}
	// Session creation needs a same-origin POST.
	resp := f.req("POST", "/_connect/session", map[string]string{"Origin": "https://evil.example.com"}, `{"grant":"`+f.grant(nil)+`"}`)
	if resp.StatusCode != 403 {
		t.Fatalf("cross-origin session: got %d", resp.StatusCode)
	}
}

func TestProxyAndCSRF(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	r := f.req("GET", "/api/system/info", map[string]string{"Cookie": cookie(tok) + "; theme=dark"}, "")
	var echo map[string]string
	json.NewDecoder(r.Body).Decode(&echo)
	if r.StatusCode != 200 || echo["host"] != testHost || echo["xfp"] != "https" {
		t.Fatalf("proxy: %d %v", r.StatusCode, echo)
	}
	if strings.Contains(echo["cookie"], CookieName) || echo["cookie"] != "theme=dark" {
		t.Fatalf("session cookie leaked upstream: %q", echo["cookie"])
	}
	for _, c := range r.Cookies() {
		if c.Name == CookieName {
			t.Fatal("upstream could plant the session cookie")
		}
	}
	if r.Header.Get("X-Frame-Options") != "DENY" {
		t.Fatal("missing X-Frame-Options")
	}
	if r := f.req("POST", "/api/system/reboot", map[string]string{"Cookie": cookie(tok)}, ""); r.StatusCode != 403 {
		t.Fatalf("POST without Origin: got %d", r.StatusCode)
	}
	if r := f.req("POST", "/api/system/reboot", map[string]string{"Cookie": cookie(tok), "Origin": "https://evil.example.com"}, ""); r.StatusCode != 403 {
		t.Fatalf("cross-origin POST: got %d", r.StatusCode)
	}
	if r := f.req("POST", "/api/system/reboot", map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost}, ""); r.StatusCode != 200 {
		t.Fatalf("same-origin POST: got %d", r.StatusCode)
	}
	for _, p := range []string{"/api//mowglinext/publish/x", "/api/x/../mowglinext/publish/x", "/api/a%2Fb"} {
		if r := f.req("GET", p, map[string]string{"Cookie": cookie(tok)}, ""); r.StatusCode != 400 {
			t.Errorf("non-canonical %s: got %d", p, r.StatusCode)
		}
	}
}

func TestSSEStreams(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	r := f.req("POST", "/api/setup/flashBoard", map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost}, "{}")
	start := time.Now()
	line, err := bufio.NewReader(r.Body).ReadString('\n')
	if err != nil || line != "event: stage\n" || time.Since(start) > 80*time.Millisecond {
		t.Fatalf("first SSE event not streamed promptly: %q %v %v", line, err, time.Since(start))
	}
}

func (f *fixture) dialWS(path, tok, origin string) (*websocket.Conn, *http.Response, error) {
	u := "ws" + strings.TrimPrefix(f.srv.URL, "http") + path
	h := http.Header{"Origin": {origin}, "Host": {testHost}}
	if tok != "" {
		h.Set("Cookie", cookie(tok))
	}
	d := websocket.Dialer{EnableCompression: true}
	return d.Dial(u, h)
}

func TestWebSocket(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	origin := "https://" + testHost

	if _, resp, err := f.dialWS("/api/mowglinext/multiplex", "", origin); err == nil || resp.StatusCode != 401 {
		t.Fatal("unauthenticated websocket accepted")
	}
	if _, resp, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://evil.example.com"); err == nil || resp.StatusCode != 403 {
		t.Fatal("cross-origin websocket accepted")
	}
	if _, resp, err := f.dialWS("/api/mowglinext/publish/cmd_vel", tok, origin); err == nil || resp.StatusCode != 403 {
		t.Fatal("teleop allowed by default")
	}

	c, _, err := f.dialWS("/api/mowglinext/multiplex", tok, origin)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	big := make([]byte, 2<<20) // a large binary frame, like a full occupancy grid
	big[0] = 0x82
	if err := c.WriteMessage(websocket.BinaryMessage, big); err != nil {
		t.Fatal(err)
	}
	typ, msg, err := c.ReadMessage()
	if err != nil || typ != websocket.BinaryMessage || len(msg) != len(big)+5 || msg[5] != 0x82 {
		t.Fatalf("binary relay failed: %v %d", err, len(msg))
	}

	// Revoking all sessions (epoch bump) must close the live socket.
	f.state.Epoch = 4
	f.gw.UpdateState(f.state)
	c.SetReadDeadline(time.Now().Add(wsAuthRecheck + 5*time.Second))
	_, _, err = c.ReadMessage()
	if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("socket not closed on revocation: %v", err)
	}
}

func TestTeleopOptIn(t *testing.T) {
	f := newFixture(t, MowgliPolicy{AllowTeleop: true})
	tok, _ := f.login(f.grant(nil))
	c, _, err := f.dialWS("/api/mowglinext/publish/cmd_vel", tok, "https://"+testHost)
	if err != nil {
		t.Fatalf("teleop opt-in failed: %v", err)
	}
	c.Close()
}

func TestViewerAndMembership(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	// A viewer grant claiming owner is capped by the membership list.
	tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:2" }))
	if tok == "" {
		t.Fatal("viewer login failed")
	}
	h := map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost}
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 200 {
		t.Fatalf("viewer read: %d", r.StatusCode)
	}
	for _, p := range []string{"/api/config/envs", "/api/settings", "/api/settings/yaml", "/api/remote-access/settings",
		"/api/tools/rosbag/download/x", "/api/diagnostics/snapshot", "/api/params", "/api/fleet/robots", "/api/new-endpoint", "/swagger/index.html"} {
		if r := f.req("GET", p, h, ""); r.StatusCode != 403 {
			t.Errorf("viewer GET %s: %d", p, r.StatusCode)
		}
	}
	if r := f.req("POST", "/api/mowglinext/call/start", h, ""); r.StatusCode != 403 {
		t.Fatalf("viewer POST: %d", r.StatusCode)
	}
	c, _, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://"+testHost)
	if err != nil {
		t.Fatalf("viewer subscribe socket: %v", err)
	}
	c.Close()

	// Removing the member invalidates the session.
	delete(f.state.Members, "gh:2")
	f.gw.UpdateState(f.state)
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 401 {
		t.Fatalf("removed member still authorized: %d", r.StatusCode)
	}
}

func TestSessionExpiry(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	f.now = f.now.Add(SessionTTL + time.Second)
	if r := f.req("GET", "/api/system/info", map[string]string{"Cookie": cookie(tok)}, ""); r.StatusCode != 401 {
		t.Fatalf("expired session accepted: %d", r.StatusCode)
	}
}

func TestStaleRelayStateFailsClosed(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	h := map[string]string{"Cookie": cookie(tok)}
	f.now = f.now.Add(59 * time.Minute)
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 200 {
		t.Fatalf("fresh-enough state rejected: %d", r.StatusCode)
	}
	f.now = f.now.Add(2 * time.Minute) // relay unreachable for longer than MaxStale
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 401 {
		t.Fatalf("stale state still authorizes: %d", r.StatusCode)
	}
	if tok2, _ := f.login(f.grant(func(c map[string]any) { c["iat"] = f.now.Unix(); c["exp"] = f.now.Unix() + 60 })); tok2 != "" {
		t.Fatal("grant accepted on stale state")
	}
	f.gw.MarkFresh()
	if tok3, _ := f.login(f.grant(func(c map[string]any) { c["iat"] = f.now.Unix(); c["exp"] = f.now.Unix() + 60 })); tok3 == "" {
		t.Fatal("grant rejected after relay recovered")
	}
}

func TestSessionsSurviveRestartButNotRevocation(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	file := t.TempDir() + "/sessions.json"
	f.gw.cfg.SessionFile = file
	tok, _ := f.login(f.grant(nil))
	if b, _ := os.ReadFile(file); strings.Contains(string(b), tok) {
		t.Fatal("raw session token written to disk")
	}
	restart := func() {
		cfg := f.gw.cfg
		f.gw = New(cfg)
		f.gw.UpdateState(f.state) // cached state at startup, before any relay sync
		f.srv.Config.Handler = f.gw
	}
	restart()
	h := map[string]string{"Cookie": cookie(tok)}
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 401 {
		t.Fatalf("session usable before first relay sync: %d", r.StatusCode)
	}
	f.gw.MarkFresh()
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 200 {
		t.Fatalf("session lost across restart: %d", r.StatusCode)
	}
	f.state.Epoch = 9 // owner signed everyone out while the agent was down
	f.gw.UpdateState(f.state)
	restart()
	f.gw.MarkFresh()
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 401 {
		t.Fatalf("revoked session resurrected: %d", r.StatusCode)
	}
}

// A device signed out on the relay bumps the robot's session epoch: sessions and grants issued
// before it stop working (the relay's app sign-out and device revocation rely on this).
func TestEpochBumpEndsEarlierSessionsAndGrants(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	unused := f.grant(nil) // issued before the bump, not yet redeemed
	cookie := map[string]string{"Cookie": CookieName + "=" + tok}
	if r := f.req("GET", "/api/system/info", cookie, ""); r.StatusCode != 200 {
		t.Fatalf("session before the bump: %d", r.StatusCode)
	}
	f.state.Epoch++
	f.gw.UpdateState(f.state)
	if r := f.req("GET", "/api/system/info", cookie, ""); r.StatusCode == 200 {
		t.Fatal("session issued before the epoch bump still works")
	}
	if t2, status := f.login(unused); t2 != "" || status != 401 {
		t.Fatalf("grant issued before the epoch bump accepted (status %d)", status)
	}
	if t3, _ := f.login(f.grant(func(c map[string]any) { c["epoch"] = f.state.Epoch })); t3 == "" {
		t.Fatal("a fresh grant at the new epoch was refused")
	}
}
