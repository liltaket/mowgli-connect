// Package client is the agent side of Mowgli Connect delegations (docs/agent-delegation.md):
// the delegate key, signed relay calls and read-only robot sessions.
package client

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var b64 = base64.RawURLEncoding

// DefaultRelay is the hosted relay.
const DefaultRelay = "https://connect.bronc.app"

// Profile is one delegate identity: a key file and its settings, in a directory of its own.
type Profile struct {
	Dir   string
	Relay string
	Key   ed25519.PrivateKey
}

type profileConfig struct {
	Relay string `json:"relay"`
}

// ProfileDir is $MC_DELEGATE_HOME/<profile>, else <user config dir>/mowgli-connect-delegate/<profile>.
func ProfileDir(profile string) (string, error) {
	if profile == "" || strings.ContainsAny(profile, `/\`) || strings.HasPrefix(profile, ".") {
		return "", fmt.Errorf("invalid profile name %q", profile)
	}
	base := os.Getenv("MC_DELEGATE_HOME")
	if base == "" {
		cfg, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(cfg, "mowgli-connect-delegate")
	}
	return filepath.Join(base, profile), nil
}

// DelegateID derives the delegate id from the public key, exactly like a robot id.
func DelegateID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:10]))
}

// Fingerprint formats an id as the consent page shows it: abcd-efgh-ijkl-mnop.
func Fingerprint(id string) string {
	var parts []string
	for i := 0; i < len(id); i += 4 {
		parts = append(parts, id[i:min(i+4, len(id))])
	}
	return strings.Join(parts, "-")
}

func (p *Profile) Public() ed25519.PublicKey { return p.Key.Public().(ed25519.PublicKey) }
func (p *Profile) ID() string                { return DelegateID(p.Public()) }
func (p *Profile) PublicKeyB64() string      { return b64.EncodeToString(p.Public()) }

// insideGitWorkTree reports whether dir is inside a Git working tree (a key there could be committed).
func insideGitWorkTree(dir string) bool {
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			return true
		}
		if filepath.Dir(d) == d {
			return false
		}
	}
}

// Create makes a new key (file mode 600, directory 700). It never overwrites an existing key.
func Create(dir, relay string) (*Profile, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if insideGitWorkTree(abs) {
		return nil, fmt.Errorf("refusing to keep a key inside a Git working tree (%s); set MC_DELEGATE_HOME to a directory outside it", abs)
	}
	if err := validRelay(relay); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(abs, 0o700); err != nil {
		return nil, err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(abs, "key"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("a key already exists in %s; use another --profile, or delete that profile directory to start over", abs)
	}
	if err != nil {
		return nil, err
	}
	_, werr := f.WriteString(b64.EncodeToString(seed) + "\n")
	serr := f.Sync()
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil || serr != nil {
		return nil, errors.Join(werr, serr)
	}
	cfg, _ := json.MarshalIndent(profileConfig{Relay: relay}, "", "  ")
	if err := os.WriteFile(filepath.Join(abs, "config.json"), append(cfg, '\n'), 0o600); err != nil {
		return nil, err
	}
	return &Profile{Dir: abs, Relay: relay, Key: ed25519.NewKeyFromSeed(seed)}, nil
}

// Load reads a profile, refusing a key file that others can read or that lies in a Git working tree.
func Load(dir string) (*Profile, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	keyPath := filepath.Join(abs, "key")
	st, err := os.Lstat(keyPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("no key in %s: run mc-delegate init first", abs)
	}
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", keyPath)
	}
	if st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is readable by other users (mode %o); run: chmod 600 %s", keyPath, st.Mode().Perm(), keyPath)
	}
	if insideGitWorkTree(abs) {
		return nil, fmt.Errorf("refusing to use a key inside a Git working tree (%s)", abs)
	}
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	seed, err := b64.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(seed) != ed25519.SeedSize {
		// Never include the file's content in an error.
		return nil, fmt.Errorf("%s is not a valid key file", keyPath)
	}
	p := &Profile{Dir: abs, Relay: DefaultRelay, Key: ed25519.NewKeyFromSeed(seed)}
	if b, err := os.ReadFile(filepath.Join(abs, "config.json")); err == nil {
		var c profileConfig
		if json.Unmarshal(b, &c) == nil && c.Relay != "" {
			p.Relay = c.Relay
		}
	}
	if err := validRelay(p.Relay); err != nil {
		return nil, err
	}
	return p, nil
}

// validRelay accepts an https origin, or plain http to this machine only (wrangler dev).
func validRelay(relay string) error {
	local := strings.HasPrefix(relay, "http://127.0.0.1:") || strings.HasPrefix(relay, "http://localhost:")
	if !(strings.HasPrefix(relay, "https://") || local) || strings.Count(relay, "/") != 2 || strings.ContainsAny(relay, "?#@ \\") {
		return fmt.Errorf("the relay must be an https origin without a path, like %s", DefaultRelay)
	}
	return nil
}
