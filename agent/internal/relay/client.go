// Package relay is the robot-side client for the Mowgli Connect relay API.
package relay

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"mowgli-connect/agent/internal/jws"
)

var (
	ErrAlreadyClaimed = errors.New("relay: robot already claimed")
	ErrUnknownRobot   = errors.New("relay: robot not registered")
	// ErrNotSigned: the answer carries no signature that verifies under the pinned relay keys
	// (or, before anything is pinned, under the keys the answer itself lists). Whoever answered
	// at the relay's address is not the relay, or the relay lost its key.
	ErrNotSigned = errors.New("relay: answer not signed by the pinned relay key")
)

type Client struct {
	Origin  string // e.g. https://connect.example.com
	Key     ed25519.PrivateKey
	RobotID string
	HTTP    *http.Client
	Now     func() time.Time
	// Agent, if set, is sent as the MC-Agent header so the relay can show the robot's agent
	// version and local settings, e.g. "version=1.2.3; teleop=off". Informational only.
	Agent string
	// Pinned, if not empty, are the relay keys this robot trusts: Self and ReportHostname
	// accept only answers signed by one of them (docs/protocol.md, "Signed answers and the
	// relay key"). Empty: an unsigned answer is accepted (a relay from before signed answers),
	// and a signed one must verify under the keys it lists itself (first contact).
	Pinned []RelayKey
}

type Registration struct {
	RobotID     string `json:"robotId"`
	PairingCode string `json:"pairingCode"`
	ClaimURL    string `json:"claimUrl"`
	ExpiresAt   int64  `json:"expiresAt"`
}

type RelayKey struct {
	Kid       string `json:"kid"`
	PublicKey string `json:"publicKey"`
}

type Member struct {
	UserID string `json:"userId"`
	Role   string `json:"role"`
}

type Self struct {
	RobotID      string     `json:"robotId"`
	Status       string     `json:"status"`
	Hostname     string     `json:"hostname"`
	TunnelToken  string     `json:"tunnelToken"`
	RelayKeys    []RelayKey `json:"relayKeys"`
	SessionEpoch int64      `json:"sessionEpoch"`
	Members      []Member   `json:"members"`
	// UpdatesPaused: the relay's operator holds back agent updates on every robot (update.sh
	// asks the agent, see "connect-agent updates").
	UpdatesPaused bool `json:"updatesPaused,omitempty"`
	// Signatures of the answer (compact JWS, typ mc-self+jwt), one per relay key. Only the
	// payload of a verified one is used.
	Signatures []string `json:"signatures,omitempty"`
}

// Signed is what a verified signature says about an answer.
type Signed struct {
	Origin string // where the relay lives now (its RELAY_ORIGIN)
	Kid    string // the key that verified the answer
}

type selfClaims struct {
	Aud         string          `json:"aud"`
	Req         string          `json:"req"`
	RelayOrigin string          `json:"relayOrigin"`
	Self        json.RawMessage `json:"self"`
}

// maxSignatures bounds the work an answer can cause.
const maxSignatures = 4

// verifySelf returns the signed content of an answer to the request with this jti. The outer,
// unsigned fields are used only for an unsigned answer while nothing is pinned.
func (c *Client) verifySelf(outer *Self, jti string) (*Self, *Signed, error) {
	if len(outer.Signatures) == 0 {
		if len(c.Pinned) > 0 {
			return nil, nil, ErrNotSigned
		}
		return outer, nil, nil
	}
	keys := c.Pinned
	if len(keys) == 0 {
		keys = outer.RelayKeys
	}
	byKid := map[string]RelayKey{}
	for _, k := range keys {
		byKid[k.Kid] = k
	}
	for i, sig := range outer.Signatures {
		if i == maxSignatures {
			break
		}
		var cl selfClaims
		h, err := jws.Verify(sig, "mc-self+jwt", func(h jws.Header) (ed25519.PublicKey, bool) {
			k, ok := byKid[h.Kid]
			if !ok || h.Kid == "" {
				return nil, false
			}
			pub, err := jws.DecodeKey(k.PublicKey)
			return pub, err == nil
		}, &cl)
		if err != nil || cl.Aud != "mc-robot:"+c.RobotID || cl.Req != jti || len(cl.Self) == 0 {
			continue
		}
		var s Self
		if err := json.Unmarshal(cl.Self, &s); err != nil || s.RobotID != c.RobotID {
			continue
		}
		s.Signatures = nil
		return &s, &Signed{Origin: cl.RelayOrigin, Kid: h.Kid}, nil
	}
	return nil, nil, ErrNotSigned
}

type assertion struct {
	Iss string `json:"iss"`
	Aud string `json:"aud"`
	Htm string `json:"htm"`
	Htu string `json:"htu"`
	Iat int64  `json:"iat"`
	Exp int64  `json:"exp"`
	Jti string `json:"jti"`
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// do sends a signed request and returns the status and the jti of its assertion (a signed
// answer names it, so an older answer cannot be replayed).
func (c *Client) do(ctx context.Context, method, path string, body any, out any) (int, string, error) {
	u, err := url.Parse(strings.TrimRight(c.Origin, "/") + path)
	if err != nil {
		return 0, "", err
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, "", err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return 0, "", err
	}
	jti := make([]byte, 16)
	if _, err := rand.Read(jti); err != nil {
		return 0, "", err
	}
	jtiS := base64.RawURLEncoding.EncodeToString(jti)
	htu := *u
	htu.RawQuery, htu.Fragment = "", ""
	iat := c.now().Unix()
	tok, err := jws.Sign(c.Key, "mc-robot+jwt", "", assertion{
		Iss: c.RobotID, Aud: strings.TrimRight(c.Origin, "/"), Htm: method, Htu: htu.String(),
		Iat: iat, Exp: iat + 60, Jti: jtiS,
	})
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "MC-Robot "+tok)
	req.Header.Set("Accept", "application/json")
	if c.Agent != "" {
		req.Header.Set("MC-Agent", c.Agent)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := c.HTTP
	if hc == nil {
		hc = NoRedirectClient(20 * time.Second)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, jtiS, err
	}
	if resp.StatusCode/100 != 2 {
		return resp.StatusCode, jtiS, fmt.Errorf("relay: %s %s: %d %s", method, path, resp.StatusCode, bytes.TrimSpace(data))
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, jtiS, fmt.Errorf("relay: decode %s: %w", path, err)
		}
	}
	return resp.StatusCode, jtiS, nil
}

// Register announces the robot key and returns a fresh pairing code.
func (c *Client) Register(ctx context.Context, name string) (*Registration, error) {
	var r Registration
	status, _, err := c.do(ctx, http.MethodPost, "/v1/robots/register", map[string]string{
		"publicKey": jws.EncodeKey(c.Key.Public().(ed25519.PublicKey)), "name": name,
	}, &r)
	if status == http.StatusConflict {
		return nil, ErrAlreadyClaimed
	}
	if err != nil {
		return nil, err
	}
	if r.RobotID != c.RobotID {
		return nil, fmt.Errorf("relay: robot id mismatch (got %q)", r.RobotID)
	}
	return &r, nil
}

// ReportHostname tells the relay the robot's current quick-tunnel hostname.
func (c *Client) ReportHostname(ctx context.Context, hostname string) (*Self, *Signed, error) {
	var s Self
	_, jti, err := c.do(ctx, http.MethodPost, "/v1/robots/hostname", map[string]string{"hostname": hostname}, &s)
	if err != nil {
		return nil, nil, err
	}
	return c.checkSelf(&s, jti)
}

// Self fetches the robot's current authorization state. Signed is nil for an unsigned answer
// (accepted only while nothing is pinned).
func (c *Client) Self(ctx context.Context) (*Self, *Signed, error) {
	var s Self
	status, jti, err := c.do(ctx, http.MethodGet, "/v1/robots/self", nil, &s)
	if status == http.StatusNotFound || status == http.StatusUnauthorized {
		return nil, nil, ErrUnknownRobot
	}
	if err != nil {
		return nil, nil, err
	}
	return c.checkSelf(&s, jti)
}

func (c *Client) checkSelf(outer *Self, jti string) (*Self, *Signed, error) {
	if outer.RobotID != c.RobotID {
		return nil, nil, fmt.Errorf("relay: robot id mismatch (got %q)", outer.RobotID)
	}
	return c.verifySelf(outer, jti)
}

// NoRedirectClient never follows redirects: the relay's answer is used as is, so a relay (or
// anything in front of it) cannot make the agent send requests to other addresses.
func NoRedirectClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}
