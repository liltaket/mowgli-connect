package relay

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mowgli-connect/agent/internal/jws"
)

// fakeRelay answers /v1/robots/self like the relay: the answer, plus signatures over
// {aud, req, relayOrigin, self} by each key in sign. tamper, if set, changes the answer after
// signing (the outer, unsigned copy only).
type fakeRelay struct {
	sign        map[string]ed25519.PrivateKey
	listed      []RelayKey
	origin      string // relayOrigin in the signed payload ("" = the server's own URL)
	unsigned    bool
	aud, req    string // overrides
	tamper      func(m map[string]any)
	srv         *httptest.Server
	lastRequest string
}

func newKey(t *testing.T) (ed25519.PrivateKey, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv, jws.EncodeKey(pub)
}

func (f *fakeRelay) start(t *testing.T) {
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "MC-Robot ")
		parts := strings.Split(tok, ".")
		var a assertion
		if len(parts) == 3 {
			b, _ := base64.RawURLEncoding.DecodeString(parts[1])
			_ = json.Unmarshal(b, &a)
		}
		f.lastRequest = a.Jti
		self := map[string]any{"robotId": a.Iss, "status": "claimed", "hostname": "r.example", "tunnelToken": "tok",
			"relayKeys": f.listed, "sessionEpoch": 3, "members": []Member{{UserID: "gh:1", Role: "owner"}}}
		origin := f.origin
		if origin == "" {
			origin = f.srv.URL
		}
		aud, req := "mc-robot:"+a.Iss, a.Jti
		if f.aud != "" {
			aud = f.aud
		}
		if f.req != "" {
			req = f.req
		}
		var sigs []string
		if !f.unsigned {
			for kid, k := range f.sign {
				s, err := jws.Sign(k, "mc-self+jwt", kid, map[string]any{"aud": aud, "req": req, "iat": 1, "relayOrigin": origin, "self": self})
				if err != nil {
					t.Error(err)
				}
				sigs = append(sigs, s)
			}
		}
		out := map[string]any{}
		for k, v := range self {
			out[k] = v
		}
		if f.tamper != nil {
			f.tamper(out)
		}
		if len(sigs) > 0 {
			out["signatures"] = sigs
		}
		_ = json.NewEncoder(w).Encode(out)
	}))
	t.Cleanup(f.srv.Close)
}

func testClient(t *testing.T, origin string) *Client {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	return &Client{Origin: origin, Key: priv, RobotID: "abcdefghijklmnop", HTTP: NoRedirectClient(5e9)}
}

func TestSelfSignatures(t *testing.T) {
	k1, p1 := newKey(t)
	k2, p2 := newKey(t)
	listed := []RelayKey{{Kid: "k1", PublicKey: p1}}
	ctx := context.Background()

	t.Run("unsigned is accepted only while nothing is pinned", func(t *testing.T) {
		f := &fakeRelay{listed: listed, unsigned: true}
		f.start(t)
		c := testClient(t, f.srv.URL)
		s, sg, err := c.Self(ctx)
		if err != nil || sg != nil || s.Status != "claimed" {
			t.Fatalf("unpinned, unsigned: %v %v %v", s, sg, err)
		}
		c.Pinned = listed
		if _, _, err := c.Self(ctx); !errors.Is(err, ErrNotSigned) {
			t.Fatalf("pinned, unsigned: want ErrNotSigned, got %v", err)
		}
	})

	t.Run("first contact verifies under the listed keys and uses only the signed content", func(t *testing.T) {
		f := &fakeRelay{sign: map[string]ed25519.PrivateKey{"k1": k1}, listed: listed, origin: "https://new.example",
			tamper: func(m map[string]any) { m["members"] = []Member{{UserID: "gh:666", Role: "owner"}} }}
		f.start(t)
		c := testClient(t, f.srv.URL)
		s, sg, err := c.Self(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if sg == nil || sg.Kid != "k1" || sg.Origin != "https://new.example" {
			t.Fatalf("signed: %+v", sg)
		}
		if len(s.Members) != 1 || s.Members[0].UserID != "gh:1" || s.Signatures != nil {
			t.Fatalf("the unsigned outer copy was used: %+v", s)
		}
	})

	t.Run("an answer signed by a key that is not pinned is refused", func(t *testing.T) {
		f := &fakeRelay{sign: map[string]ed25519.PrivateKey{"k1": k2}, listed: []RelayKey{{Kid: "k1", PublicKey: p2}}}
		f.start(t)
		c := testClient(t, f.srv.URL)
		c.Pinned = listed // pinned k1 = p1; the answer is signed by another key under the same kid
		if _, _, err := c.Self(ctx); !errors.Is(err, ErrNotSigned) {
			t.Fatalf("want ErrNotSigned, got %v", err)
		}
	})

	t.Run("a rotation: signed by the pinned key and the new one, listing both", func(t *testing.T) {
		both := []RelayKey{{Kid: "k2", PublicKey: p2}, {Kid: "k1", PublicKey: p1}}
		f := &fakeRelay{sign: map[string]ed25519.PrivateKey{"k1": k1, "k2": k2}, listed: both}
		f.start(t)
		c := testClient(t, f.srv.URL)
		c.Pinned = listed
		s, sg, err := c.Self(ctx)
		if err != nil || sg.Kid != "k1" || len(s.RelayKeys) != 2 {
			t.Fatalf("rotation: %+v %+v %v", s, sg, err)
		}
	})

	t.Run("an answer to another request or for another robot is refused", func(t *testing.T) {
		for name, f := range map[string]*fakeRelay{
			"replayed": {sign: map[string]ed25519.PrivateKey{"k1": k1}, listed: listed, req: "an-older-request-jti-123"},
			"other":    {sign: map[string]ed25519.PrivateKey{"k1": k1}, listed: listed, aud: "mc-robot:qqqqqqqqqqqqqqqq"},
		} {
			f.start(t)
			c := testClient(t, f.srv.URL)
			c.Pinned = listed
			if _, _, err := c.Self(ctx); !errors.Is(err, ErrNotSigned) {
				t.Fatalf("%s: want ErrNotSigned, got %v", name, err)
			}
			c.Pinned = nil
			if _, _, err := c.Self(ctx); !errors.Is(err, ErrNotSigned) {
				t.Fatalf("%s, first contact: want ErrNotSigned, got %v", name, err)
			}
		}
	})
}
