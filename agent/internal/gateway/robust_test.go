package gateway

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Any path the gateway lets through must be one whose meaning a router cannot change by
// normalizing it, and the teleop prefix must stay blocked for every spelling of it.
func FuzzCanonicalPathPolicy(f *testing.F) {
	for _, s := range []string{"/", "/api/mowglinext/publish/x", "/api//mowglinext/publish/x", "/api/./mowglinext/publish/x",
		"/api/x/../mowglinext/publish/x", "/api/mowglinext/publish/", "/api/mowglinext/publish", "/%2e%2e/api", "/a%2Fb", "/api/mowglinext/publish%2Fx"} {
		f.Add(s)
	}
	pol := MowgliPolicy{}
	f.Fuzz(func(t *testing.T, raw string) {
		u, err := url.ParseRequestURI(raw)
		if err != nil {
			return
		}
		if !canonicalPath(u) {
			return
		}
		clean := path.Clean(u.Path)
		if strings.HasSuffix(u.Path, "/") && clean != "/" {
			clean += "/"
		}
		if clean != u.Path {
			t.Fatalf("non-canonical path accepted: %q (clean %q)", u.Path, clean)
		}
		if strings.HasPrefix(u.Path, "/api/mowglinext/publish/") && pol.Allow(RoleOwner, "GET", u.Path, true) {
			t.Fatalf("teleop allowed for %q", u.Path)
		}
		if pol.Allow(RoleViewer, "GET", u.Path, true) && !strings.HasPrefix(u.Path, "/api/mowglinext/multiplex") && !strings.HasPrefix(u.Path, "/api/mowglinext/subscribe/") {
			t.Fatalf("viewer socket allowed for %q", u.Path)
		}
	})
}

func TestBodyLimitReturns413(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	f.gw.cfg.MaxBodyBytes = 1024
	tok, _ := f.login(f.grant(nil))
	r := f.req("POST", "/api/import/openmower", map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost}, strings.Repeat("x", 4096))
	if r.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: got %d", r.StatusCode)
	}
	// Chunked upload without Content-Length is cut off while streaming.
	pr, pw := io.Pipe()
	go func() { pw.Write([]byte(strings.Repeat("x", 4096))); pw.Close() }()
	req, _ := http.NewRequest("POST", f.srv.URL+"/api/import/openmower", pr)
	req.Host = testHost
	req.Header.Set("Cookie", cookie(tok))
	req.Header.Set("Origin", "https://"+testHost)
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized chunked body: got %d", resp.StatusCode)
	}
}

func TestUpstreamDown(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	dead := httptest.NewServer(http.NotFoundHandler())
	u, _ := url.Parse(dead.URL)
	dead.Close()
	f.gw.cfg.Upstream = u
	f.gw.proxy = New(f.gw.cfg).proxy
	tok, _ := f.login(f.grant(nil))
	if r := f.req("GET", "/api/system/info", map[string]string{"Cookie": cookie(tok)}, ""); r.StatusCode != http.StatusBadGateway {
		t.Fatalf("http with upstream down: %d", r.StatusCode)
	}
	if _, resp, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://"+testHost); err == nil || resp == nil || resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("ws with upstream down: %v", err)
	}
}

// Many concurrent sockets and requests (several tabs, several users) must relay correctly
// and leave no goroutines behind when clients go away.
func TestConcurrentSocketsNoLeak(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	settle := func() int {
		time.Sleep(200 * time.Millisecond)
		return runtime.NumGoroutine()
	}
	before := settle()

	const clients, msgs = 40, 50
	var wg sync.WaitGroup
	errs := make(chan error, clients*2)
	for i := 0; i < clients; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			c, _, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://"+testHost)
			if err != nil {
				errs <- err
				return
			}
			defer c.Close()
			for j := 0; j < msgs; j++ {
				want := fmt.Sprintf("c%d-m%d", i, j)
				if err := c.WriteMessage(websocket.TextMessage, []byte(want)); err != nil {
					errs <- err
					return
				}
				_, got, err := c.ReadMessage()
				if err != nil || string(got) != "echo:"+want {
					errs <- fmt.Errorf("client %d msg %d: %q %v", i, j, got, err)
					return
				}
			}
		}(i)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				r, _ := http.NewRequest("GET", f.srv.URL+"/api/system/info", nil)
				r.Host = testHost
				r.Header.Set("Cookie", cookie(tok))
				resp, err := http.DefaultClient.Do(r)
				if err != nil {
					errs <- err
					return
				}
				resp.Body.Close()
				if resp.StatusCode != 200 {
					errs <- fmt.Errorf("http %d", resp.StatusCode)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	http.DefaultClient.CloseIdleConnections()
	http.DefaultTransport.(*http.Transport).CloseIdleConnections()
	deadline := time.Now().Add(5 * time.Second)
	for {
		after := settle()
		if after <= before+5 {
			break
		}
		if time.Now().After(deadline) {
			buf := make([]byte, 1<<16)
			t.Fatalf("goroutine leak: before %d after %d\n%s", before, after, buf[:runtime.Stack(buf, true)])
		}
	}
}

// A browser that stops reading (backgrounded phone tab) must not wedge the agent: the socket
// is dropped after the write timeout and other clients keep working.
func TestStalledClientIsDropped(t *testing.T) {
	if testing.Short() {
		t.Skip("slow")
	}
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(nil))
	stalled, _, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://"+testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close()
	big := make([]byte, 1<<20)
	go func() {
		// Keep sending; the fake GUI echoes 1 MB frames back that nobody reads.
		for i := 0; i < 64; i++ {
			if stalled.WriteMessage(websocket.BinaryMessage, big) != nil {
				return
			}
		}
	}()
	time.Sleep(wsWriteTimeout + 3*time.Second)
	ok, _, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://"+testHost)
	if err != nil {
		t.Fatalf("healthy client blocked: %v", err)
	}
	defer ok.Close()
	ok.WriteMessage(websocket.TextMessage, []byte("hi"))
	ok.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, m, err := ok.ReadMessage(); err != nil || string(m) != "echo:hi" {
		t.Fatalf("healthy client: %q %v", m, err)
	}
	stalled.SetReadDeadline(time.Now().Add(time.Second))
	for {
		if _, _, err := stalled.ReadMessage(); err != nil {
			break // drained buffered frames, then the agent's close
		}
	}
}
