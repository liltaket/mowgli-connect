package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestContainerGuard(t *testing.T) {
	const (
		self = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a"
		gui  = "c0ffee0000000000000000000000000000000000000000000000000000000001"
		ros  = "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"
	)
	calls := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/api/containers/" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"containers":[{"id":"` + self + `","names":["/mowgli-connect"]},{"id":"` + gui + `","names":["/mowgli-gui"]},{"id":"` + ros + `","names":["/mowgli-ros2"]}]}`))
	}))
	defer up.Close()
	u, _ := url.Parse(up.URL)
	g := &ContainerGuard{Upstream: u, SelfID: self, Names: []string{"mowgli-connect", "mowgli-gui"}}

	for _, tc := range []struct {
		method, path string
		deny         bool
	}{
		{"POST", "/api/containers/" + self + "/stop", true},
		{"POST", "/api/containers/" + self[:12] + "/stop", true},
		{"POST", "/api/containers/" + gui + "/stop", true},
		{"POST", "/api/containers/mowgli-gui/stop", true},
		{"POST", "/api/containers/mowgli-connect/stop/", true},
		{"POST", "/api/containers/" + ros + "/stop", false},     // other containers: owner's choice
		{"POST", "/api/containers/" + self + "/restart", false}, // comes back by itself
		{"GET", "/api/containers/" + self + "/stop", false},
		{"POST", "/api/containers/" + self[:4] + "/stop", true}, // Docker resolves short prefixes too
		{"POST", "/api/containers/" + gui[:1] + "/stop", true},
		{"POST", "/api/containers/" + ros[:6] + "/stop", false},
	} {
		if got := g.Denies(tc.method, tc.path); got != tc.deny {
			t.Errorf("%s %s: deny=%v, want %v", tc.method, tc.path, got, tc.deny)
		}
	}
	if calls > 1 {
		t.Fatalf("container list fetched %d times, want it cached", calls)
	}

	// The list cannot be read: refuse every stop rather than risk the lockout.
	up.Close()
	blind := &ContainerGuard{Upstream: u, Names: []string{"mowgli-gui"}}
	if !blind.Denies("POST", "/api/containers/"+ros+"/stop") {
		t.Fatal("stop allowed without the container list")
	}
}

func TestGuardInGateway(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	f.gw.cfg.Guard = denyAll{}
	tok, _ := f.login(f.grant(nil))
	r := f.req("POST", "/api/containers/x/stop", map[string]string{"Cookie": CookieName + "=" + tok, "Origin": "https://" + testHost}, "")
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", r.StatusCode)
	}
}

type denyAll struct{}

func (denyAll) Deny(*http.Request) string { return "no" }

func TestMowgliGuard(t *testing.T) {
	g := &MowgliGuard{}
	req := func(method, path, body string) *http.Request {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		return r
	}
	for _, tc := range []struct {
		method, path, body string
		deny               bool
	}{
		{"POST", "/api/system/shutdown", "", true},
		{"POST", "/api/system/reboot", "", false},
		{"PUT", "/api/remote-access/settings", `{"authKey":"x"}`, true},
		{"POST", "/api/remote-access/apply", "", true},
		{"GET", "/api/remote-access/status", "", false},
		{"POST", "/api/config/keys/set", `{"system.map.tileServer":"http://192.168.1.1"}`, true},
		{"POST", "/api/config/keys/set", `{"system.map.enabled":"true","system.map.tileServer":"x"}`, true},
		{"POST", "/api/config/keys/set", `{"system.map.enabled":"true"}`, false},
		{"POST", "/api/config/keys/set", `not json`, false},
	} {
		r := req(tc.method, tc.path, tc.body)
		if got := g.Deny(r) != ""; got != tc.deny {
			t.Errorf("%s %s %s: deny=%v, want %v", tc.method, tc.path, tc.body, got, tc.deny)
		}
		// The body is still there for the proxy.
		if b, _ := io.ReadAll(r.Body); string(b) != tc.body {
			t.Errorf("%s %s: body %q after the guard, want %q", tc.method, tc.path, b, tc.body)
		}
	}
}
