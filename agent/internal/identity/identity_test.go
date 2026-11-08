package identity

import (
	"bytes"
	"crypto/ed25519"
	"path/filepath"
	"testing"
)

// Shared test vector with the relay (relay/README.md): 32 bytes of 0x01.
func TestRobotIDVector(t *testing.T) {
	id := RobotID(ed25519.PublicKey(bytes.Repeat([]byte{1}, 32)))
	t.Logf("robotId(32x0x01) = %s", id)
	if id != "olgw5bbcyqd7w3ij" {
		t.Fatalf("robotId vector mismatch: %q", id)
	}
}

func TestLoadOrCreatePersists(t *testing.T) {
	p := filepath.Join(t.TempDir(), "k", "robot.key")
	a, err := LoadOrCreate(p)
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreate(p)
	if err != nil || !a.Equal(b) {
		t.Fatal("key not persisted")
	}
}
