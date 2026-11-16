// Package pin keeps the relay keys a robot trusts, and the relay origin it uses, across
// restarts (docs/protocol.md, "Signed answers and the relay key").
//
// The robot pins the relay's public keys from its first signed answer. From then on it accepts
// only answers signed by a pinned key, so the relay's domain, DNS and TLS certificate are no
// longer enough to hand the robot other members, keys or a tunnel token. The relay can rotate its
// key (an answer signed by a pinned key lists the new one) and move to another domain (a signed
// answer names the new origin; the robot moves after the new origin answers with a pinned key).
package pin

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"mowgli-connect/agent/internal/jws"
	"mowgli-connect/agent/internal/relay"
)

// MaxKeys bounds how many relay keys are pinned at once (current and previous, with room).
const MaxKeys = 8

type Pin struct {
	Keys []relay.RelayKey `json:"keys"`
	// Origin is the relay origin in use: MC_RELAY_URL, or where a signed answer moved the robot.
	Origin string `json:"origin"`
	// Configured is MC_RELAY_URL when Origin was chosen. If the owner sets another MC_RELAY_URL
	// on the robot, that wins again (the robot's own configuration is the owner's decision).
	Configured string `json:"configured"`
}

// Load reads a pin file. A missing file is (nil, nil): nothing is pinned yet.
func Load(path string) (*Pin, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p Pin
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(Valid(p.Keys)) == 0 {
		return nil, fmt.Errorf("%s: no usable relay key", path)
	}
	return &p, nil
}

// Save writes atomically with mode 0600.
func Save(path string, p *Pin) error {
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".pin-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// Valid returns the well-formed keys (a kid and a 32-byte Ed25519 key, no duplicate kid), at
// most MaxKeys of them, in order.
func Valid(keys []relay.RelayKey) []relay.RelayKey {
	out := []relay.RelayKey{}
	seen := map[string]bool{}
	for _, k := range keys {
		if k.Kid == "" || seen[k.Kid] || len(out) == MaxKeys {
			continue
		}
		if _, err := jws.DecodeKey(k.PublicKey); err != nil {
			continue
		}
		seen[k.Kid] = true
		out = append(out, relay.RelayKey{Kid: k.Kid, PublicKey: k.PublicKey})
	}
	return out
}

// Same reports whether two key lists are equal.
func Same(a, b []relay.RelayKey) bool {
	return reflect.DeepEqual(Valid(a), Valid(b))
}

// CheckOrigin accepts an origin a signed answer names: https (http only when allowHTTP, for
// local development), a host, nothing else (no path, query, user or fragment).
func CheckOrigin(s string, allowHTTP bool) error {
	if len(s) > 200 || s != strings.TrimRight(s, "/") {
		return errors.New("bad relay origin")
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return errors.New("bad relay origin")
	}
	if u.Scheme != "https" && !(allowHTTP && u.Scheme == "http") {
		return errors.New("relay origin must use https")
	}
	if u.Scheme+"://"+u.Host != s {
		return errors.New("bad relay origin")
	}
	return nil
}
