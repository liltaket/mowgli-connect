package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mowgli-connect/delegate/internal/client"
)

func fakeGitHub(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/users/bruno" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`{"login":"Bruno","id":120603498,"type":"User"}`))
	}))
	old := client.GitHubAPI
	client.GitHubAPI = srv.URL
	t.Cleanup(func() { client.GitHubAPI = old; srv.Close() })
}

func TestInitAndRequestNeverPrintTheKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("MC_DELEGATE_HOME", home)
	fakeGitHub(t)
	var out, errOut strings.Builder
	if err := run(context.Background(), []string{"--profile", "farm", "init"}, nil, &out, &errOut); err != nil {
		t.Fatal(err, errOut.String())
	}
	seed, err := os.ReadFile(filepath.Join(home, "farm", "key"))
	if err != nil {
		t.Fatal(err)
	}
	if err := run(context.Background(), []string{"--profile", "farm", "request", "--name", "Sim Farm", "--scopes", "robots:claim"}, nil, &out, &errOut); err == nil {
		t.Fatal("request without --account accepted")
	}
	if err := run(context.Background(), []string{"--profile", "farm", "request", "--account", "bruno", "--name", "Sim Farm", "--scopes", "robots:claim,robots:manage", "--ttl", "7d"}, nil, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if cfg, _ := os.ReadFile(filepath.Join(home, "farm", "config.json")); !strings.Contains(string(cfg), `"account": "Bruno"`) || !strings.Contains(string(cfg), `"account_id": "gh:120603498"`) {
		t.Fatalf("account not remembered: %s", cfg)
	}
	all := out.String() + errOut.String()
	if strings.Contains(all, strings.TrimSpace(string(seed))) {
		t.Fatal("the private key was printed")
	}
	i := strings.Index(all, "https://connect.bronc.app/delegate/authorize?")
	if i < 0 {
		t.Fatalf("no consent link: %s", all)
	}
	u, _ := url.Parse(strings.Fields(all[i:])[0])
	q := u.Query()
	parts := strings.Split(q.Get("req"), ".")
	if len(q.Get("key")) != 43 || len(parts) != 3 {
		t.Fatalf("link %s", u)
	}
	var claims map[string]any
	pb, _ := base64.RawURLEncoding.DecodeString(parts[1])
	json.Unmarshal(pb, &claims)
	if claims["name"] != "Sim Farm" || claims["scopes"] != "robots:claim robots:manage" || claims["ttl"] != 604800.0 || claims["account"] != "Bruno" || claims["uid"] != "gh:120603498" {
		t.Fatalf("request %v", claims)
	}
	if err := run(context.Background(), []string{"--profile", "farm", "init"}, nil, &out, &errOut); err == nil {
		t.Fatal("init must not replace a key")
	}
}

func TestUnlinkAndRevokeNeedYes(t *testing.T) {
	t.Setenv("MC_DELEGATE_HOME", t.TempDir())
	var out, errOut strings.Builder
	if err := run(context.Background(), []string{"init"}, nil, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"unlink", "abcdefghijklmnop"}, {"revoke"}} {
		if err := run(context.Background(), args, nil, &out, &errOut); err == nil || !strings.Contains(err.Error(), "--yes") {
			t.Errorf("%v: %v", args, err)
		}
	}
}

func TestParseTTL(t *testing.T) {
	for in, want := range map[string]time.Duration{"1h": time.Hour, "8h": 8 * time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour} {
		if got, err := parseTTL(in); err != nil || got != want {
			t.Errorf("%s: %v %v", in, got, err)
		}
	}
	for _, in := range []string{"10m", "31d", "0d", "-1h", "forever"} {
		if _, err := parseTTL(in); err == nil {
			t.Errorf("%s accepted", in)
		}
	}
}
