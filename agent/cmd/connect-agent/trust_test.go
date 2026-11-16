package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"mowgli-connect/agent/internal/jws"
	"mowgli-connect/agent/internal/pin"
	"mowgli-connect/agent/internal/relay"
)

// testRelay signs /v1/robots/self like the relay, naming `origin` (default: itself) as where it
// lives and listing `listed` as its keys.
type testRelay struct {
	key    ed25519.PrivateKey
	kid    string
	listed []relay.RelayKey
	origin string
	paused bool
	calls  atomic.Int32
	srv    *httptest.Server
}

func newTestRelay(t *testing.T, kid string) *testRelay {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	r := &testRelay{key: priv, kid: kid, listed: []relay.RelayKey{{Kid: kid, PublicKey: jws.EncodeKey(pub)}}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.calls.Add(1)
		parts := strings.Split(strings.TrimPrefix(req.Header.Get("Authorization"), "MC-Robot "), ".")
		var a struct{ Iss, Jti string }
		if len(parts) == 3 {
			b, _ := base64.RawURLEncoding.DecodeString(parts[1])
			_ = json.Unmarshal(b, &a)
		}
		origin := r.origin
		if origin == "" {
			origin = r.srv.URL
		}
		self := map[string]any{"robotId": a.Iss, "status": "claimed", "hostname": "r.example", "relayKeys": r.listed,
			"sessionEpoch": 1, "members": []relay.Member{}, "updatesPaused": r.paused}
		sig, _ := jws.Sign(r.key, "mc-self+jwt", r.kid, map[string]any{"aud": "mc-robot:" + a.Iss, "req": a.Jti, "relayOrigin": origin, "self": self})
		self["signatures"] = []string{sig}
		_ = json.NewEncoder(w).Encode(self)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newClient(origin string) *relay.Client {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)

	return &relay.Client{Origin: origin, Key: priv, RobotID: "abcdefghijklmnop", HTTP: relay.NoRedirectClient(5e9)}
}

func syncOnce(t *testing.T, tr *trust, c *relay.Client) (*relay.Self, *relay.Signed, error) {
	t.Helper()
	s, sg, err := c.Self(context.Background())
	if err != nil {
		return nil, nil, err
	}
	s, sg = tr.afterSync(context.Background(), c, s, sg)
	return s, sg, nil
}

func TestTrustPinsAndFollowsASignedMove(t *testing.T) {
	dir := t.TempDir()
	old := newTestRelay(t, "k1")
	tr, err := loadTrust(dir, old.srv.URL, true, quietLog())
	if err != nil || tr.pin != nil {
		t.Fatalf("fresh: %v %+v", err, tr.pin)
	}
	c := newClient(tr.origin())
	if _, sg, err := syncOnce(t, tr, c); err != nil || sg == nil {
		t.Fatalf("first sync: %v", err)
	}
	if tr.pin == nil || tr.pin.Keys[0].Kid != "k1" || len(c.Pinned) != 1 {
		t.Fatalf("not pinned: %+v", tr.pin)
	}

	// The relay moves: same key at a new address; the old address names it.
	moved := newTestRelay(t, "k1")
	moved.key, moved.listed = old.key, old.listed
	old.origin = moved.srv.URL
	if _, _, err := syncOnce(t, tr, c); err != nil {
		t.Fatal(err)
	}
	if c.Origin != moved.srv.URL || tr.origin() != moved.srv.URL {
		t.Fatalf("did not move: client %s, pin %s", c.Origin, tr.origin())
	}
	// It survives a restart, as long as MC_RELAY_URL is unchanged.
	tr2, err := loadTrust(dir, old.srv.URL, true, quietLog())
	if err != nil || tr2.origin() != moved.srv.URL || tr2.issuer() != moved.srv.URL {
		t.Fatalf("after restart: %v %s", err, tr2.origin())
	}
	// The owner setting another MC_RELAY_URL wins; the keys stay pinned.
	tr3, err := loadTrust(dir, "https://chosen.example", true, quietLog())
	if err != nil || tr3.origin() != "https://chosen.example" || len(tr3.keys()) != 1 {
		t.Fatalf("owner's MC_RELAY_URL: %v %s", err, tr3.origin())
	}
}

func TestTrustRefusesAMoveToAnotherKey(t *testing.T) {
	dir := t.TempDir()
	old := newTestRelay(t, "k1")
	tr, _ := loadTrust(dir, old.srv.URL, true, quietLog())
	c := newClient(tr.origin())
	if _, _, err := syncOnce(t, tr, c); err != nil {
		t.Fatal(err)
	}
	impostor := newTestRelay(t, "k1") // same kid, another key
	old.origin = impostor.srv.URL
	if _, _, err := syncOnce(t, tr, c); err != nil {
		t.Fatal(err)
	}
	if c.Origin != old.srv.URL || tr.origin() != old.srv.URL {
		t.Fatalf("moved to a relay with another key: %s", c.Origin)
	}
	if impostor.calls.Load() == 0 {
		t.Fatal("the new address was never checked")
	}
	// And whoever answers at the old address with another key is not believed at all.
	impostor.origin = ""
	c2 := newClient(impostor.srv.URL)
	c2.Pinned = tr.keys()
	if _, _, err := c2.Self(context.Background()); err == nil {
		t.Fatal("answer signed by another key accepted")
	}
}

func TestTrustFollowsAKeyRotation(t *testing.T) {
	dir := t.TempDir()
	r := newTestRelay(t, "k1")
	tr, _ := loadTrust(dir, r.srv.URL, true, quietLog())
	c := newClient(tr.origin())
	if _, _, err := syncOnce(t, tr, c); err != nil {
		t.Fatal(err)
	}
	pub2, _, _ := ed25519.GenerateKey(rand.Reader)
	r.listed = append([]relay.RelayKey{{Kid: "k2", PublicKey: jws.EncodeKey(pub2)}}, r.listed...) // signed by k1
	if _, _, err := syncOnce(t, tr, c); err != nil {
		t.Fatal(err)
	}
	if got := kids(tr.keys()); len(got) != 2 || got[0] != "k2" {
		t.Fatalf("rotation not pinned: %v", got)
	}
	p, err := pin.Load(filepath.Join(dir, pinFile))
	if err != nil || len(p.Keys) != 2 {
		t.Fatalf("not saved: %v %+v", err, p)
	}
}

func TestUpdateHold(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MC_DATA_DIR", dir)
	out := func() string {
		t.Helper()
		r, w, _ := os.Pipe()
		stdout := os.Stdout
		os.Stdout = w
		err := updates()
		os.Stdout = stdout
		w.Close()
		b, _ := io.ReadAll(r)
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}
	if got := out(); got != "active" {
		t.Fatalf("got %q", got)
	}
	setUpdateHold(dir, true, quietLog())
	if got := out(); got != "paused" {
		t.Fatalf("got %q", got)
	}
	setUpdateHold(dir, false, quietLog())
	if got := out(); got != "active" {
		t.Fatalf("got %q", got)
	}
}

func TestCheckOrigin(t *testing.T) {
	for s, ok := range map[string]bool{
		"https://connect.example.com":         true,
		"https://connect.example.com:8443":    true,
		"http://connect.example.com":          false,
		"https://connect.example.com/":        false,
		"https://connect.example.com/x":       false,
		"https://user@connect.example.com":    false,
		"https://connect.example.com?x=1":     false,
		"https://connect.example.com#x":       false,
		"javascript:alert(1)":                 false,
		"":                                    false,
		"https://" + strings.Repeat("a", 300): false,
	} {
		if err := pin.CheckOrigin(s, false); (err == nil) != ok {
			t.Errorf("CheckOrigin(%q) = %v, want ok=%v", s, err, ok)
		}
	}
}
