// Package identity owns the robot's long-lived Ed25519 key and derived robot id.
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RobotID derives the protocol robot id: lowercase base32 of SHA-256(pub)[:10].
func RobotID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:10]))
}

// LoadOrCreate reads the key seed at path, creating a new key (mode 0600) if absent.
func LoadOrCreate(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		seed, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(b)))
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("identity: corrupt key file %s", path)
		}
		return ed25519.NewKeyFromSeed(seed), nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.WriteString(base64.RawURLEncoding.EncodeToString(seed) + "\n"); err != nil {
		return nil, err
	}
	return ed25519.NewKeyFromSeed(seed), f.Sync()
}
