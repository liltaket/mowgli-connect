package tunnel

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A stand-in for cloudflared that prints a quick-tunnel banner with a per-start hostname.
const fakeQuick = `#!/bin/sh
n=$(cat "$0.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0.count"
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF |  https://api.trycloudflare.com  |" >&2
echo "INF |  https://run-$n-abc.trycloudflare.com      |" >&2
for a in "$@"; do echo "arg $a" >&2; done
exec sleep 30
`

func TestQuickTunnelHostnameAndRestart(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "cloudflared")
	if err := os.WriteFile(bin, []byte(fakeQuick), 0o755); err != nil {
		t.Fatal(err)
	}
	hosts := make(chan string, 4)
	s := &Supervisor{Binary: bin, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil)), OnHostname: func(h string) { hosts <- h }}
	defer s.Stop()
	s.Set(Spec{QuickURL: "http://127.0.0.1:4007"})
	want := func(exp string) {
		select {
		case h := <-hosts:
			if h != exp {
				t.Fatalf("hostname %q, want %q", h, exp)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no hostname reported (want %q)", exp)
		}
	}
	want("run-1-abc.trycloudflare.com")
	s.Set(Spec{QuickURL: "http://127.0.0.1:4007"}) // unchanged spec: no restart
	s.Restart()
	want("run-2-abc.trycloudflare.com")
	s.Stop()
	select {
	case h := <-hosts:
		t.Fatalf("unexpected extra hostname %q", h)
	case <-time.After(300 * time.Millisecond):
	}
	if n, _ := os.ReadFile(bin + ".count"); strings.TrimSpace(string(n)) != "2" {
		t.Fatalf("cloudflared started %s times, want 2", n)
	}
}
