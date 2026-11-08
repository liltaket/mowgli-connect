// Package jws implements the minimal compact JWS (EdDSA / Ed25519 only) used by the
// Mowgli Connect protocol. See docs/protocol.md.
package jws

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var b64 = base64.RawURLEncoding

type Header struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
	Kid string `json:"kid,omitempty"`
}

// Sign returns a compact JWS of claims signed with priv.
func Sign(priv ed25519.PrivateKey, typ, kid string, claims any) (string, error) {
	h, err := json.Marshal(Header{Alg: "EdDSA", Typ: typ, Kid: kid})
	if err != nil {
		return "", err
	}
	p, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	input := b64.EncodeToString(h) + "." + b64.EncodeToString(p)
	return input + "." + b64.EncodeToString(ed25519.Sign(priv, []byte(input))), nil
}

// KeyFunc resolves the verification key for a header. Return ok=false to reject.
type KeyFunc func(h Header) (ed25519.PublicKey, bool)

// Verify checks alg, typ and the signature, then decodes the payload into claims.
// It does not check any claim; callers must validate iss/aud/exp/jti themselves.
func Verify(token, wantTyp string, key KeyFunc, claims any) (Header, error) {
	var h Header
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return h, errors.New("jws: malformed token")
	}
	hb, err := b64.DecodeString(parts[0])
	if err != nil {
		return h, errors.New("jws: bad header encoding")
	}
	if err := json.Unmarshal(hb, &h); err != nil {
		return h, errors.New("jws: bad header")
	}
	if h.Alg != "EdDSA" {
		return h, fmt.Errorf("jws: unsupported alg %q", h.Alg)
	}
	if h.Typ != wantTyp {
		return h, fmt.Errorf("jws: unexpected typ %q", h.Typ)
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return h, errors.New("jws: bad signature encoding")
	}
	pub, ok := key(h)
	if !ok || len(pub) != ed25519.PublicKeySize {
		return h, errors.New("jws: unknown key")
	}
	if !ed25519.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
		return h, errors.New("jws: invalid signature")
	}
	pb, err := b64.DecodeString(parts[1])
	if err != nil {
		return h, errors.New("jws: bad payload encoding")
	}
	if err := json.Unmarshal(pb, claims); err != nil {
		return h, errors.New("jws: bad payload")
	}
	return h, nil
}

// DecodeKey decodes a base64url raw Ed25519 public key.
func DecodeKey(s string) (ed25519.PublicKey, error) {
	b, err := b64.DecodeString(s)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("jws: bad public key")
	}
	return ed25519.PublicKey(b), nil
}

func EncodeKey(pub ed25519.PublicKey) string { return b64.EncodeToString(pub) }
