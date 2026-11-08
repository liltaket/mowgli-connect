package gateway

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// useUpstream points the fixture's gateway at a test-specific app.
func (f *fixture) useUpstream(h http.Handler) {
	srv := httptest.NewServer(h)
	f.t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	f.gw.cfg.Upstream = u
	f.gw.proxy = New(f.gw.cfg).proxy
}

const pageHTML = `<!doctype html><html><HEAD lang="x"><title>GUI</title></head><body></body></html>`

func TestShimInjectionCachingAndGzip(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	big := strings.Repeat(`{"cell":0},`, 500)
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		io.WriteString(w, pageHTML)
	})
	mux.HandleFunc("/assets/a.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		io.WriteString(w, "console.log(1)")
	})
	mux.HandleFunc("/api/big", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `"v1"`)
		io.WriteString(w, big)
	})
	f.useUpstream(mux)
	tok, _ := f.login(f.grant(nil))
	c := map[string]string{"Cookie": cookie(tok)}

	r := f.req("GET", "/map", map[string]string{"Cookie": cookie(tok), "Accept": "text/html", "Accept-Encoding": "gzip"}, "")
	body, _ := io.ReadAll(r.Body)
	if want := `<HEAD lang="x">` + shimTag + `<title>`; !strings.Contains(string(body), want) || r.Header.Get("Content-Encoding") != "" {
		t.Fatalf("shim not injected: %q %q", body, r.Header.Get("Content-Encoding"))
	}
	if r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("html cache-control changed: %q", r.Header.Get("Cache-Control"))
	}
	r = f.req("GET", "/assets/a.js", c, "")
	if cc := r.Header.Get("Cache-Control"); cc != "private, max-age=31536000, immutable" {
		t.Fatalf("asset cache-control: %q", cc)
	}
	r = f.req("GET", "/api/big", map[string]string{"Cookie": cookie(tok), "Accept-Encoding": "gzip"}, "")
	if r.Header.Get("Content-Encoding") != "gzip" || r.Header.Get("ETag") != `W/"v1"` {
		t.Fatalf("api not gzipped: %v", r.Header)
	}
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := io.ReadAll(zr); string(got) != big {
		t.Fatalf("gzip body mismatch")
	}
	r = f.req("GET", "/api/big", c, "")
	if got, _ := io.ReadAll(r.Body); r.Header.Get("Content-Encoding") != "" || string(got) != big {
		t.Fatalf("plain body for client without gzip: %q", r.Header.Get("Content-Encoding"))
	}
	r = f.req("GET", "/_connect/ws.js", nil, "")
	if got, _ := io.ReadAll(r.Body); r.StatusCode != 200 || !strings.Contains(string(got), "DecompressionStream") {
		t.Fatalf("ws.js: %d", r.StatusCode)
	}

	f.gw.cfg.WSCompression = false
	f.gw.proxy = New(f.gw.cfg).proxy
	r = f.req("GET", "/", map[string]string{"Cookie": cookie(tok), "Accept": "text/html"}, "")
	if body, _ := io.ReadAll(r.Body); string(body) != pageHTML {
		t.Fatalf("shim injected with compression off: %q", body)
	}
}

func readFramed(t *testing.T, c *websocket.Conn) (byte, []byte) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	typ, m, err := c.ReadMessage()
	if err != nil || typ != websocket.BinaryMessage || len(m) == 0 {
		t.Fatalf("framed read: typ %d len %d %v", typ, len(m), err)
	}
	if m[0]&wsFlagDeflate == 0 {
		return m[0], m[1:]
	}
	out, err := io.ReadAll(flate.NewReader(bytes.NewReader(m[1:])))
	if err != nil {
		t.Fatal(err)
	}
	return m[0], out
}

func TestWSCompressedFraming(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	c, _, err := f.dialWS("/api/mowglinext/multiplex?"+wsCompressParam+"=1", tok, "https://"+testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	big := strings.Repeat("grid ", 400)
	c.WriteMessage(websocket.TextMessage, []byte(big))
	if flag, got := readFramed(t, c); flag != wsFlagText|wsFlagDeflate || string(got) != "echo:"+big {
		t.Fatalf("big text: flag %d len %d", flag, len(got))
	}
	c.WriteMessage(websocket.BinaryMessage, []byte{1, 2, 3})
	if flag, got := readFramed(t, c); flag != 0 || !bytes.Equal(got, []byte("echo:\x01\x02\x03")) {
		t.Fatalf("small binary: flag %d %q", flag, got)
	}
}

// mpFrame builds a GUI-style multiplex frame; dataFirst puts the data key before topic.
func mpFrame(topic string, seq byte, dataFirst bool) []byte {
	t := append([]byte{0xa5}, "topic"...)
	t = append(append(t, 0xa0|byte(len(topic))), topic...)
	d := append([]byte{0xa4}, "data"...)
	d = append(d, 0x92, 0xc4, 3, 9, 9, seq, 0xcb, 0, 0, 0, 0, 0, 0, 0, 0) // [bin(3), float64]
	if dataFirst {
		return append(append([]byte{0x82}, d...), t...)
	}
	return append(append([]byte{0x82}, t...), d...)
}

func TestMsgpackTopic(t *testing.T) {
	for _, df := range []bool{false, true} {
		if got, ok := msgpackTopic(mpFrame("mowProgress", 1, df)); !ok || got != "mowProgress" {
			t.Fatalf("dataFirst=%v: %q %v", df, got, ok)
		}
	}
	for _, b := range [][]byte{nil, {0x82}, {0x81, 0xa5}, {0x90}, mpFrame("x", 1, true)[:12]} {
		if _, ok := msgpackTopic(b); ok {
			t.Fatalf("accepted malformed %x", b)
		}
	}
}

func FuzzMsgpackTopic(f *testing.F) {
	f.Add(mpFrame("lidar", 1, true))
	f.Add([]byte{0xdf, 0xff, 0xff, 0xff, 0xff})
	f.Add([]byte{0x81, 0xa4, 'd', 'a', 't', 'a', 0xdd, 0x7f, 0xff, 0xff, 0xff})
	f.Fuzz(func(t *testing.T, b []byte) {
		msgpackTopic(b) // must not panic or hang
		if p, ok := mpSkip(b, 0); ok && (p <= 0 || p > len(b)) {
			t.Fatalf("skip offset %d of %d", p, len(b))
		}
	})
}

func TestTopicThrottle(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	f.gw.cfg.ThrottlePath = "/api/mowglinext/multiplex"
	f.gw.cfg.Throttle = map[string]time.Duration{"grid": 300 * time.Millisecond}
	up := websocket.Upgrader{}
	f.useUpstream(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for i := byte(1); i <= 20; i++ { // 20 grids and 20 poses over ~200 ms
			c.WriteMessage(websocket.BinaryMessage, mpFrame("grid", i, i%2 == 0))
			c.WriteMessage(websocket.BinaryMessage, mpFrame("pose", i, false))
			time.Sleep(10 * time.Millisecond)
		}
		c.ReadMessage() // hold the socket open until the client goes away
	}))
	tok, _ := f.login(f.grant(nil))
	c, _, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://"+testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var grids, poses []byte
	deadline := time.Now().Add(1500 * time.Millisecond)
	for {
		_ = c.SetReadDeadline(deadline)
		_, m, err := c.ReadMessage()
		if err != nil {
			break
		}
		topic, _ := msgpackTopic(m)
		seq := m[bytes.Index(m, []byte{0xc4, 3, 9, 9})+4]
		if topic == "grid" {
			grids = append(grids, seq)
		} else {
			poses = append(poses, seq)
		}
	}
	if len(poses) != 20 {
		t.Fatalf("unthrottled topic lost frames: %v", poses)
	}
	if len(grids) < 1 || len(grids) > 3 || grids[0] != 1 || grids[len(grids)-1] != 20 {
		t.Fatalf("grid frames %v: want the first, at most one in between, and the latest last", grids)
	}
}

func TestResyncAdmitsNewMember(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	calls := 0
	f.gw.cfg.Resync = func() {
		calls++
		st := f.state
		st.Epoch = 4
		st.Members = map[string]string{"gh:1": RoleOwner, "gh:7": RoleViewer}
		f.gw.UpdateState(st)
	}
	g := f.grant(func(c map[string]any) { c["sub"] = "gh:7"; c["role"] = RoleViewer; c["epoch"] = 4 })
	if tok, status := f.login(g); tok == "" {
		t.Fatalf("new member after resync rejected: %d", status)
	}
	// A second unknown grant within resyncMinGap does not trigger another relay call.
	if tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:8"; c["epoch"] = 4 })); tok != "" || calls != 1 {
		t.Fatalf("resync not rate limited: calls %d", calls)
	}
}

// Browsers send "Origin: null" on same-origin POSTs under strict referrer policies; that is
// accepted only with Sec-Fetch-Site: same-origin, and never for WebSocket upgrades.
func TestNullOriginNeedsSameOriginFetchSite(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	for site, want := range map[string]int{"cross-site": 403, "same-site": 403, "": 403, "same-origin": 200} {
		h := map[string]string{"Cookie": cookie(tok), "Origin": "null"}
		if site != "" {
			h["Sec-Fetch-Site"] = site
		}
		if r := f.req("POST", "/api/system/reboot", h, ""); r.StatusCode != want {
			t.Errorf("Sec-Fetch-Site %q: got %d, want %d", site, r.StatusCode, want)
		}
	}
	d := websocket.Dialer{}
	u := strings.Replace(f.srv.URL, "http", "ws", 1) + "/api/mowglinext/multiplex"
	if _, resp, err := d.Dial(u, http.Header{"Host": {testHost}, "Cookie": {cookie(tok)}, "Origin": {"null"}, "Sec-Fetch-Site": {"same-origin"}}); err == nil || resp == nil || resp.StatusCode != 403 {
		t.Fatalf("websocket with null origin accepted")
	}
}

// An open socket must end when its session is logged out, and an owner-only socket must end
// when the member is downgraded to viewer (security review 3, MC3-01).
func TestSocketEndsOnLogoutAndDowngrade(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	closed := func(c *websocket.Conn) bool {
		_ = c.SetReadDeadline(time.Now().Add(wsAuthRecheck + 3*time.Second))
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return websocket.IsCloseError(err, websocket.ClosePolicyViolation)
			}
		}
	}

	tok, _ := f.login(f.grant(nil))
	c, _, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://"+testHost)
	if err != nil {
		t.Fatal(err)
	}
	if r := f.req("POST", "/_connect/logout", map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost}, ""); r.StatusCode != 204 {
		t.Fatalf("logout: %d", r.StatusCode)
	}
	if !closed(c) {
		t.Fatal("socket survived logout")
	}

	tok, _ = f.login(f.grant(nil))
	c, _, err = f.dialWS("/api/containers/x/logs", tok, "https://"+testHost)
	if err != nil {
		t.Fatal(err)
	}
	st := f.state
	st.Members = map[string]string{"gh:1": RoleViewer}
	f.gw.UpdateState(st)
	if !closed(c) {
		t.Fatal("owner-only socket survived downgrade to viewer")
	}
}

// A consumed grant must stay consumed across an agent restart (MC3-05).
func TestGrantNotReusableAfterRestart(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	f.gw.cfg.SessionFile = t.TempDir() + "/sessions.json"
	g := f.grant(nil)
	if tok, _ := f.login(g); tok == "" {
		t.Fatal("first login failed")
	}
	cfg := f.gw.cfg
	f.gw = New(cfg) // restart: same data dir, same moment
	f.gw.UpdateState(f.state)
	f.gw.MarkFresh()
	f.srv.Config.Handler = f.gw
	if tok, status := f.login(g); tok != "" {
		t.Fatalf("consumed grant accepted after restart (status %d)", status)
	}
	if tok, _ := f.login(f.grant(nil)); tok == "" {
		t.Fatal("fresh grant rejected after restart")
	}
}

// HTML too large to rewrite is passed through complete (MC3-06).
func TestLargeHTMLPassesThroughUnchanged(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	big := "<html><head></head><body>" + strings.Repeat("x", maxInjectHTML+1000) + "</body></html>"
	f.useUpstream(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		if r.URL.Path == "/chunked" {
			w.(http.Flusher).Flush() // no Content-Length
		}
		io.WriteString(w, big)
	}))
	tok, _ := f.login(f.grant(nil))
	for _, p := range []string{"/", "/chunked"} {
		r := f.req("GET", p, map[string]string{"Cookie": cookie(tok), "Accept": "text/html"}, "")
		if body, _ := io.ReadAll(r.Body); string(body) != big {
			t.Fatalf("%s: got %d bytes, want %d unchanged", p, len(body), len(big))
		}
	}
}

// If the consumed grant cannot be written, no session is issued; and without a readable record
// of the previous run's grants, grants issued around startup are refused (security review 4,
// MC4-01).
func TestReplayStateFailsClosed(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	f.gw.cfg.SessionFile = t.TempDir() + "/missing-dir/sessions.json"
	if tok, status := f.login(f.grant(nil)); tok != "" || status != 401 {
		t.Fatalf("session issued although it could not be persisted (status %d)", status)
	}

	cfg := f.gw.cfg
	cfg.SessionFile = t.TempDir() + "/sessions.json" // no file yet: previous grants unknown
	f.gw = New(cfg)
	f.gw.UpdateState(f.state)
	f.gw.MarkFresh()
	f.srv.Config.Handler = f.gw
	if tok, _ := f.login(f.grant(nil)); tok != "" {
		t.Fatal("grant issued at startup accepted without replay records")
	}
	f.now = f.now.Add(ClockSkew + 2*time.Second)
	if tok, _ := f.login(f.grant(nil)); tok == "" {
		t.Fatal("grant issued after startup rejected")
	}
}

// The app must not be able to set the gateway cookie, however it spaces the name (review G-05).
func TestUpstreamCannotPlantSessionCookie(t *testing.T) {
	h := http.Header{}
	for _, v := range []string{CookieName + "=a", " " + CookieName + " =b; Path=/", CookieName + "\t=c", "other=1"} {
		h.Add("Set-Cookie", v)
	}
	hardenResponse(h)
	if got := h.Values("Set-Cookie"); len(got) != 1 || got[0] != "other=1" {
		t.Fatalf("Set-Cookie after hardening: %q", got)
	}
}

// The sign-in page is styled from a same-origin stylesheet, links back to the relay, and keeps a
// strict CSP (no inline script or style).
func TestCallbackPage(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	r := f.req("GET", "/_connect/callback", nil, "")
	body, _ := io.ReadAll(r.Body)
	csp := r.Header.Get("Content-Security-Policy")
	if r.StatusCode != 200 || !strings.Contains(string(body), `href="`+testRelay+`/"`) || !strings.Contains(string(body), "/_connect/connect.css") {
		t.Fatalf("callback page: %d %s", r.StatusCode, body)
	}
	if !strings.Contains(csp, "style-src 'self'") || strings.Contains(csp, "unsafe-inline") || strings.Contains(string(body), "style=") {
		t.Fatalf("csp %q", csp)
	}
	if r := f.req("GET", "/_connect/connect.css", nil, ""); r.StatusCode != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "text/css") {
		t.Fatalf("css: %d", r.StatusCode)
	}
	if !strings.Contains(string(body), `rel="icon" href="/_connect/icon.svg"`) || !strings.Contains(csp, "img-src 'self'") {
		t.Fatalf("favicon link or img-src missing: %q", csp)
	}
	if r := f.req("GET", "/_connect/icon.svg", nil, ""); r.StatusCode != 200 || r.Header.Get("Content-Type") != "image/svg+xml" {
		t.Fatalf("icon: %d %q", r.StatusCode, r.Header.Get("Content-Type"))
	}
}
