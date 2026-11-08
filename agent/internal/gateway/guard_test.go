package gateway

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestContainerGuard(t *testing.T) {
	const (
		self = "f55e0e2b7ed7e924732138633de16a4f1a1293592fe999261ef9909c673a5a15"
		gui  = "c20b51c2db61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		ros  = "b909d106f6be362d57e7360f023f14917f0ace7e758611cc67f9835e89feb460"
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
		{"POST", "/api/containers/" + self[:4] + "/stop", false}, // too short to mean anything
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

func (denyAll) Denies(string, string) bool { return true }
