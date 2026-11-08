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
)

type Client struct {
	Origin  string // e.g. https://connect.example.com
	Key     ed25519.PrivateKey
	RobotID string
	HTTP    *http.Client
	Now     func() time.Time
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

func (c *Client) do(ctx context.Context, method, path string, body any, out any) (int, error) {
	u, err := url.Parse(strings.TrimRight(c.Origin, "/") + path)
	if err != nil {
		return 0, err
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return 0, err
	}
	jti := make([]byte, 16)
	if _, err := rand.Read(jti); err != nil {
		return 0, err
	}
	htu := *u
	htu.RawQuery, htu.Fragment = "", ""
	iat := c.now().Unix()
	tok, err := jws.Sign(c.Key, "mc-robot+jwt", "", assertion{
		Iss: c.RobotID, Aud: strings.TrimRight(c.Origin, "/"), Htm: method, Htu: htu.String(),
		Iat: iat, Exp: iat + 60, Jti: base64.RawURLEncoding.EncodeToString(jti),
	})
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "MC-Robot "+tok)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 20 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode/100 != 2 {
		return resp.StatusCode, fmt.Errorf("relay: %s %s: %d %s", method, path, resp.StatusCode, bytes.TrimSpace(data))
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("relay: decode %s: %w", path, err)
		}
	}
	return resp.StatusCode, nil
}

// Register announces the robot key and returns a fresh pairing code.
func (c *Client) Register(ctx context.Context, name string) (*Registration, error) {
	var r Registration
	status, err := c.do(ctx, http.MethodPost, "/v1/robots/register", map[string]string{
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
func (c *Client) ReportHostname(ctx context.Context, hostname string) (*Self, error) {
	var s Self
	if _, err := c.do(ctx, http.MethodPost, "/v1/robots/hostname", map[string]string{"hostname": hostname}, &s); err != nil {
		return nil, err
	}
	if s.RobotID != c.RobotID {
		return nil, fmt.Errorf("relay: robot id mismatch (got %q)", s.RobotID)
	}
	return &s, nil
}

// Self fetches the robot's current authorization state.
func (c *Client) Self(ctx context.Context) (*Self, error) {
	var s Self
	status, err := c.do(ctx, http.MethodGet, "/v1/robots/self", nil, &s)
	if status == http.StatusNotFound || status == http.StatusUnauthorized {
		return nil, ErrUnknownRobot
	}
	if err != nil {
		return nil, err
	}
	if s.RobotID != c.RobotID {
		return nil, fmt.Errorf("relay: robot id mismatch (got %q)", s.RobotID)
	}
	return &s, nil
}
