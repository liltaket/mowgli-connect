package client

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testKey() ed25519.PrivateKey {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	return ed25519.NewKeyFromSeed(seed)
}

// The same vector is verified by the relay (relay/test/delegation.test.ts, "the Go client's
// signature"), so both sides agree on the format byte for byte.
const vectorBody = `{"code":"lemon-otter-crisp","step":"preview"}`
const vectorJWS = "eyJhbGciOiJFZERTQSIsInR5cCI6Im1jLWRlbGVnYXRlK2p3dCJ9.eyJhdWQiOiJodHRwczovL3JlbGF5LnRlc3QiLCJiZGgiOiJYY043NVRvaFNGTkNBN05rVUhRajRGT0MzeHU2djltY3gtbDJjRjBYQlJBIiwiZXhwIjoxNzk0MDAwMDYwLCJodG0iOiJQT1NUIiwiaHR1IjoiaHR0cHM6Ly9yZWxheS50ZXN0L3YxL2RlbGVnYXRlL2NsYWltIiwiaWF0IjoxNzk0MDAwMDAwLCJpc3MiOiJtdzNhbTQ2dzV3ZWV4NGE0IiwianRpIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIn0.w-ipKIO5uXifzX3LTYI72UuJkteJBvH70YH2Cs1jyLgxt1WwsLLgdddZJZWILPX4ttiv_fyIZbVVBiya5K7RDQ"

func TestSignatureVector(t *testing.T) {
	k := testKey()
	sum := sha256.Sum256([]byte(vectorBody))
	got := signJWS(k, "mc-delegate+jwt", map[string]any{
		"iss": DelegateID(k.Public().(ed25519.PublicKey)), "aud": "https://relay.test", "htm": "POST",
		"htu": "https://relay.test/v1/delegate/claim", "bdh": b64.EncodeToString(sum[:]),
		"iat": 1794000000, "exp": 1794000060, "jti": strings.Repeat("A", 24),
	})
	if got != vectorJWS {
		t.Fatalf("vector changed:\n%s", got)
	}
	if id := DelegateID(k.Public().(ed25519.PublicKey)); id != "mw3am46w5weex4a4" {
		t.Fatalf("delegate id %s", id)
	}
	if Fingerprint("mw3am46w5weex4a4") != "mw3a-m46w-5wee-x4a4" {
		t.Fatal("fingerprint")
	}
}

// fakeRelay verifies every call the way the relay does and records the claims.
func fakeRelay(t *testing.T, pub ed25519.PublicKey, handle func(w http.ResponseWriter, r *http.Request, body []byte)) *httptest.Server {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "MC-Delegate ")
		parts := strings.Split(tok, ".")
		if !ok || len(parts) != 3 {
			t.Errorf("no assertion on %s", r.URL.Path)
			http.Error(w, "{}", 401)
			return
		}
		sig, _ := b64.DecodeString(parts[2])
		if !ed25519.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
			t.Errorf("bad signature on %s", r.URL.Path)
		}
		var c map[string]any
		pb, _ := b64.DecodeString(parts[1])
		json.Unmarshal(pb, &c)
		sum := sha256.Sum256(body)
		if c["htm"] != r.Method || c["htu"] != srv.URL+r.URL.Path || c["aud"] != srv.URL || c["bdh"] != b64.EncodeToString(sum[:]) ||
			c["iss"] != DelegateID(pub) || c["exp"].(float64)-c["iat"].(float64) != 60 || len(c["jti"].(string)) < 22 {
			t.Errorf("claims %v for %s %s", c, r.Method, r.URL.Path)
		}
		handle(w, r, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCallsAreSignedAndErrorsDecoded(t *testing.T) {
	k := testKey()
	relay := fakeRelay(t, k.Public().(ed25519.PublicKey), func(w http.ResponseWriter, r *http.Request, body []byte) {
		switch r.URL.Path {
		case "/v1/delegate/self":
			w.Write([]byte(`{"delegateId":"mw3am46w5weex4a4","login":"bruno","scopes":["robots:read"],"robots":[],"expiresAt":1}`))
		case "/v1/delegate/claim":
			if r.Header.Get("Content-Type") != "application/json" || !strings.Contains(string(body), `"step":"confirm"`) {
				t.Errorf("claim body %s", body)
			}
			w.WriteHeader(403)
			w.Write([]byte(`{"error":"scope_required","scope":"robots:claim"}`))
		}
	})
	c := &Client{Relay: relay.URL, Key: k}
	s, err := c.Self(context.Background())
	if err != nil || s.Login != "bruno" {
		t.Fatalf("self: %v %+v", err, s)
	}
	_, err = c.Claim(context.Background(), "lemon-otter-crisp", "Sim 1", true)
	var ae *APIError
	if !errors.As(err, &ae) || ae.Status != 403 || ae.Scope != "robots:claim" || !strings.Contains(err.Error(), "needs robots:claim") {
		t.Fatalf("claim error: %v", err)
	}
	if err := c.Label(context.Background(), "../../admin", "x"); err == nil {
		t.Fatal("a robot id must be checked before it goes into a URL")
	}
}

func TestReadRobotUsesAViewerSessionAndOnlyGET(t *testing.T) {
	k := testKey()
	var sessions, grants atomic.Int32
	robot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/_connect/session":
			var b map[string]string
			json.NewDecoder(r.Body).Decode(&b)
			if r.Method != "POST" || r.Header.Get("Origin") != "https://sim-1.robots.test" || b["grant"] != "G" {
				t.Errorf("session request %s %v %v", r.Method, r.Header, b)
			}
			n := sessions.Add(1)
			http.SetCookie(w, &http.Cookie{Name: "__Host-mc_session", Value: "S" + string(rune('0'+n)), Path: "/", Secure: true, HttpOnly: true})
			w.WriteHeader(http.StatusNoContent) // as the real gateway (agent/internal/gateway/connect.go)
		case r.URL.Path == "/api/system/info":
			if r.Method != "GET" {
				t.Errorf("method %s", r.Method)
			}
			if c, _ := r.Cookie("__Host-mc_session"); c == nil || c.Value != "S2" {
				w.WriteHeader(401) // the first session "ended": the client must get a new one once
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"version":"1"}`))
		case r.URL.Path == "/api/big":
			w.Write([]byte(strings.Repeat("x", maxRobotResponse+10)))
		}
	}))
	t.Cleanup(robot.Close)
	relay := fakeRelay(t, k.Public().(ed25519.PublicKey), func(w http.ResponseWriter, r *http.Request, _ []byte) {
		grants.Add(1)
		w.Write([]byte(`{"grant":"G","hostname":"sim-1.robots.test","expiresAt":1}`))
	})
	c := &Client{Relay: relay.URL, Key: k, RobotBase: func(h string) string {
		if h != "sim-1.robots.test" {
			t.Errorf("hostname %s", h)
		}
		return robot.URL
	}}
	r, err := c.ReadRobot(context.Background(), "mw3am46w5weex4a4", "/api/system/info")
	if err != nil || r.Status != 200 || string(r.Body) != `{"version":"1"}` {
		t.Fatalf("read: %v %+v", err, r)
	}
	if sessions.Load() != 2 || grants.Load() != 2 {
		t.Fatalf("sessions %d grants %d", sessions.Load(), grants.Load())
	}
	// The session is reused.
	if _, err := c.ReadRobot(context.Background(), "mw3am46w5weex4a4", "/api/system/info"); err != nil || grants.Load() != 2 {
		t.Fatalf("session not reused: %v %d", err, grants.Load())
	}
	big, err := c.ReadRobot(context.Background(), "mw3am46w5weex4a4", "/api/big")
	if err != nil || !big.Truncated || len(big.Body) != maxRobotResponse {
		t.Fatalf("big: %v %v %d", err, big.Truncated, len(big.Body))
	}
}

func TestReadRobotRefusesBadHostnames(t *testing.T) {
	k := testKey()
	for _, host := range []string{"evil.test/x", "evil.test:8443", "user@evil.test", "", "localhost"} {
		relay := fakeRelay(t, k.Public().(ed25519.PublicKey), func(w http.ResponseWriter, r *http.Request, _ []byte) {
			json.NewEncoder(w).Encode(map[string]string{"grant": "G", "hostname": host})
		})
		c := &Client{Relay: relay.URL, Key: k}
		if _, err := c.ReadRobot(context.Background(), "mw3am46w5weex4a4", "/api/system/info"); err == nil || !strings.Contains(err.Error(), "invalid robot hostname") {
			t.Errorf("%q: %v", host, err)
		}
	}
}

func TestCheckRobotPath(t *testing.T) {
	for _, p := range []string{"/api/system/info", "/api/schedules?x=1", "/"} {
		if err := CheckRobotPath(p); err != nil {
			t.Errorf("%s: %v", p, err)
		}
	}
	for _, p := range []string{"api/x", "/api/../_connect/whoami", "/api/%2e%2e/x", "/api/a%2Fb", "/_connect/logout", "/api/x#y", "/api/ x", "http://x/"} {
		if err := CheckRobotPath(p); err == nil {
			t.Errorf("%s accepted", p)
		}
	}
}

func TestKeyFiles(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "profile")
	p, err := Create(dir, DefaultRelay)
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(filepath.Join(dir, "key"))
	dst, _ := os.Stat(dir)
	if st.Mode().Perm() != 0o600 || dst.Mode().Perm() != 0o700 {
		t.Fatalf("modes %o %o", st.Mode().Perm(), dst.Mode().Perm())
	}
	if _, err := Create(dir, DefaultRelay); err == nil {
		t.Fatal("must never overwrite a key")
	}
	q, err := Load(dir)
	if err != nil || q.ID() != p.ID() || q.Relay != DefaultRelay {
		t.Fatalf("load: %v", err)
	}
	seed, _ := os.ReadFile(filepath.Join(dir, "key"))
	os.Chmod(filepath.Join(dir, "key"), 0o644)
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("loose mode accepted: %v", err)
	}
	os.WriteFile(filepath.Join(dir, "key"), []byte("not-a-key-but-secret-looking\n"), 0o600)
	if _, err := Load(dir); err == nil || strings.Contains(err.Error(), "secret-looking") {
		t.Fatalf("error must not show the file: %v", err)
	}
	if strings.Contains(p.PublicKeyB64(), strings.TrimSpace(string(seed))) {
		t.Fatal("public key output contains the seed")
	}

	repo := filepath.Join(base, "repo")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
	if _, err := Create(filepath.Join(repo, "keys"), DefaultRelay); err == nil || !strings.Contains(err.Error(), "Git working tree") {
		t.Fatalf("key inside a repository accepted: %v", err)
	}
	for _, bad := range []string{"http://connect.bronc.app", "https://connect.bronc.app/x", "https://a@b", "ftp://x"} {
		if _, err := Create(filepath.Join(base, "r"+strings.NewReplacer("/", "", ":", "").Replace(bad)), bad); err == nil {
			t.Errorf("relay %q accepted", bad)
		}
	}
	if _, err := ProfileDir("../x"); err == nil {
		t.Fatal("profile names must not be paths")
	}
}

func TestConsentURL(t *testing.T) {
	u := ConsentURL("https://connect.bronc.app", "KEY", "Claude (T3)", []string{"robots:read", "robots:claim"}, 24*time.Hour)
	if u != "https://connect.bronc.app/delegate/authorize?key=KEY&name=Claude+%28T3%29&scopes=robots%3Aread+robots%3Aclaim&ttl=86400" {
		t.Fatal(u)
	}
}
