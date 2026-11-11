package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const maxRelayResponse = 1 << 20

// Client makes signed calls to the relay's delegate API.
type Client struct {
	Relay string
	Key   ed25519.PrivateKey
	HTTP  *http.Client
	Now   func() time.Time
	// RobotBase turns a robot hostname into the base URL for robot calls (tests override it).
	RobotBase func(hostname string) string

	mu       sync.Mutex
	sessions map[string]robotSession
}

type robotSession struct {
	base, cookie string
	expires      time.Time
}

func New(p *Profile) *Client {
	return &Client{Relay: p.Relay, Key: p.Key}
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// APIError is a non-2xx answer from the relay or a robot.
type APIError struct {
	Status  int    `json:"-"`
	Code    string `json:"error"`
	Detail  string `json:"detail,omitempty"`
	Scope   string `json:"scope,omitempty"`
	Message string `json:"message,omitempty"`
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("relay answered %d %s", e.Status, e.Code)
	if e.Detail != "" {
		s += " (" + e.Detail + ")"
	}
	if e.Scope != "" {
		s += ": needs " + e.Scope
	}
	if e.Message != "" {
		s += ": " + e.Message
	}
	return s
}

// Assertion signs one call: method, relay URL and the exact body bytes, valid once for 60 s.
func (c *Client) Assertion(method, path string, body []byte) (string, error) {
	jti := make([]byte, 18)
	if _, err := rand.Read(jti); err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	now := c.now().Unix()
	claims := map[string]any{
		"iss": DelegateID(c.Key.Public().(ed25519.PublicKey)),
		"aud": c.Relay,
		"htm": strings.ToUpper(method),
		"htu": c.Relay + path,
		"bdh": b64.EncodeToString(sum[:]),
		"iat": now,
		"exp": now + 60,
		"jti": b64.EncodeToString(jti),
	}
	return "MC-Delegate " + signJWS(c.Key, "mc-delegate+jwt", claims), nil
}

func signJWS(key ed25519.PrivateKey, typ string, claims any) string {
	h, _ := json.Marshal(map[string]string{"alg": "EdDSA", "typ": typ})
	p, _ := json.Marshal(claims)
	input := b64.EncodeToString(h) + "." + b64.EncodeToString(p)
	return input + "." + b64.EncodeToString(ed25519.Sign(key, []byte(input)))
}

// Call makes one signed relay call. A changing call is never retried: its outcome may be unknown.
func (c *Client) Call(ctx context.Context, method, path string, body, out any) error {
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			return err
		}
	}
	auth, err := c.Assertion(method, path, raw)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Relay+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxRelayResponse))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		e := &APIError{Status: resp.StatusCode}
		if json.Unmarshal(b, e) != nil || e.Code == "" {
			e.Code = http.StatusText(resp.StatusCode)
		}
		return e
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(b, out)
}

// --- the API ----------------------------------------------------------------------------------

type Self struct {
	DelegateID string   `json:"delegateId"`
	Name       string   `json:"name"`
	UserID     string   `json:"userId"`
	Login      string   `json:"login"`
	Scopes     []string `json:"scopes"`
	Robots     []string `json:"robots"`
	ExpiresAt  int64    `json:"expiresAt"`
}

type Robot struct {
	RobotID         string  `json:"robotId"`
	Name            string  `json:"name"`
	Hostname        *string `json:"hostname"`
	Role            string  `json:"role"`
	Online          *bool   `json:"online"`
	Joystick        *bool   `json:"joystick"`
	UpdateAvailable *bool   `json:"updateAvailable"`
	AddedByDelegate bool    `json:"addedByDelegate"`
}

type ClaimResult struct {
	RobotID  string  `json:"robotId"`
	Name     *string `json:"name,omitempty"`
	Hostname *string `json:"hostname"`
	Taken    *string `json:"taken,omitempty"`
}

var robotID = regexp.MustCompile(`^[a-z2-7]{16}$`)

func checkRobotID(id string) error {
	if !robotID.MatchString(id) {
		return fmt.Errorf("%q is not a robot id (16 characters a-z, 2-7)", id)
	}
	return nil
}

func (c *Client) Self(ctx context.Context) (*Self, error) {
	var s Self
	return &s, c.Call(ctx, "GET", "/v1/delegate/self", nil, &s)
}

func (c *Client) Robots(ctx context.Context) ([]Robot, error) {
	var r struct {
		Robots []Robot `json:"robots"`
	}
	return r.Robots, c.Call(ctx, "GET", "/v1/delegate/robots", nil, &r)
}

// Claim previews (confirm=false) or adds (confirm=true) the robot a pairing code belongs to.
func (c *Client) Claim(ctx context.Context, code, label string, confirm bool) (*ClaimResult, error) {
	step := "preview"
	if confirm {
		step = "confirm"
	}
	body := map[string]any{"code": code, "step": step}
	if label != "" {
		body["label"] = label
	}
	var r ClaimResult
	return &r, c.Call(ctx, "POST", "/v1/delegate/claim", body, &r)
}

func (c *Client) Label(ctx context.Context, robot, label string) error {
	if err := checkRobotID(robot); err != nil {
		return err
	}
	return c.Call(ctx, "POST", "/v1/delegate/robots/"+robot+"/label", map[string]any{"label": label}, nil)
}

func (c *Client) Unlink(ctx context.Context, robot string) error {
	if err := checkRobotID(robot); err != nil {
		return err
	}
	c.forget(robot)
	return c.Call(ctx, "POST", "/v1/delegate/robots/"+robot+"/unlink", map[string]any{}, nil)
}

func (c *Client) Revoke(ctx context.Context) error {
	return c.Call(ctx, "POST", "/v1/delegate/revoke", map[string]any{}, nil)
}

// --- read-only robot sessions -----------------------------------------------------------------

const (
	maxRobotResponse = 256 << 10
	robotSessionTTL  = 11 * time.Hour // the robot's own limit is 12 hours
)

var (
	hostnameRE  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)
	robotPathRE = regexp.MustCompile(`^/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$`)
)

// RobotReply is what a robot answered. Body is untrusted data from the robot.
type RobotReply struct {
	Status      int
	ContentType string
	Body        []byte
	Truncated   bool
}

// CheckRobotPath accepts a path on the robot's own app: absolute, no fragment, no dot segments,
// nothing under /_connect/.
func CheckRobotPath(p string) error {
	if !robotPathRE.MatchString(p) {
		return fmt.Errorf("the path must start with / and contain only URL characters, like /api/system/info")
	}
	pathPart := strings.SplitN(p, "?", 2)[0]
	for _, seg := range strings.Split(pathPart, "/") {
		if seg == "." || seg == ".." || strings.Contains(strings.ToLower(seg), "%2e") || strings.Contains(strings.ToLower(seg), "%2f") {
			return fmt.Errorf("the path must not contain dot segments or encoded slashes")
		}
	}
	if strings.HasPrefix(pathPart, "/_connect") {
		return fmt.Errorf("paths under /_connect/ are the gateway's own")
	}
	return nil
}

// ReadRobot makes a read-only GET on the robot's app through a viewer session for this delegate.
// The robot enforces the viewer role itself; this client only ever sends GET.
func (c *Client) ReadRobot(ctx context.Context, robot, path string) (*RobotReply, error) {
	if err := checkRobotID(robot); err != nil {
		return nil, err
	}
	if err := CheckRobotPath(path); err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		s, err := c.session(ctx, robot)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, "GET", s.base+path, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Cookie", s.cookie)
		req.Header.Set("Accept", "application/json, text/plain;q=0.9, */*;q=0.1")
		resp, err := c.httpClient().Do(req)
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxRobotResponse+1))
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			c.forget(robot) // the session ended (revoked, or the robot restarted): get a new one once
			continue
		}
		r := &RobotReply{Status: resp.StatusCode, ContentType: resp.Header.Get("Content-Type"), Body: b}
		if len(b) > maxRobotResponse {
			r.Body, r.Truncated = b[:maxRobotResponse], true
		}
		return r, nil
	}
	return nil, errors.New("the robot refused the session")
}

func (c *Client) forget(robot string) {
	c.mu.Lock()
	delete(c.sessions, robot)
	c.mu.Unlock()
}

func (c *Client) session(ctx context.Context, robot string) (robotSession, error) {
	c.mu.Lock()
	s, ok := c.sessions[robot]
	c.mu.Unlock()
	if ok && c.now().Before(s.expires) {
		return s, nil
	}
	var g struct {
		Grant    string `json:"grant"`
		Hostname string `json:"hostname"`
	}
	if err := c.Call(ctx, "POST", "/v1/delegate/robots/"+robot+"/grant", map[string]any{}, &g); err != nil {
		return robotSession{}, err
	}
	if !hostnameRE.MatchString(g.Hostname) {
		return robotSession{}, fmt.Errorf("the relay named an invalid robot hostname")
	}
	base := "https://" + g.Hostname
	if c.RobotBase != nil {
		base = c.RobotBase(g.Hostname)
	}
	body, _ := json.Marshal(map[string]string{"grant": g.Grant})
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/_connect/session", bytes.NewReader(body))
	if err != nil {
		return robotSession{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://"+g.Hostname)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return robotSession{}, err
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	var cookie string
	for _, ck := range resp.Cookies() {
		if ck.Name == "__Host-mc_session" && ck.Value != "" {
			cookie = ck.Name + "=" + ck.Value
		}
	}
	if resp.StatusCode/100 != 2 || cookie == "" { // the robot agent answers 204 No Content
		return robotSession{}, fmt.Errorf("the robot did not accept the grant (%d)", resp.StatusCode)
	}
	s = robotSession{base: base, cookie: cookie, expires: c.now().Add(robotSessionTTL)}
	c.mu.Lock()
	if c.sessions == nil {
		c.sessions = map[string]robotSession{}
	}
	c.sessions[robot] = s
	c.mu.Unlock()
	return s, nil
}

// RequestValidity is how long a consent link works (the relay accepts at most 30 minutes).
const RequestValidity = 20 * time.Minute

// ConsentURL is the link the person opens to approve this key. What it asks for, and the only
// account that may approve it (uid, its immutable id; account, its login, is for messages), are
// signed with the key, so nobody can change them or approve the key for another account.
func (c *Client) ConsentURL(account, uid, name string, scopes []string, ttl time.Duration) string {
	pub := c.Key.Public().(ed25519.PublicKey)
	now := c.now().Unix()
	req := signJWS(c.Key, "mc-delegate-request+jwt", map[string]any{
		"iss": DelegateID(pub), "aud": c.Relay, "account": account, "uid": uid, "name": name,
		"scopes": strings.Join(scopes, " "), "ttl": int64(ttl / time.Second),
		"iat": now, "exp": now + int64(RequestValidity/time.Second),
	})
	q := url.Values{}
	q.Set("key", b64.EncodeToString(pub))
	q.Set("req", req)
	return c.Relay + "/delegate/authorize?" + q.Encode()
}

var githubLogin = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9]|-(?:[A-Za-z0-9])){0,38}$`)

// GitHubAPI is where LookupAccount asks (tests override it).
var GitHubAPI = "https://api.github.com"

// LookupAccount returns the immutable id ("gh:<number>", as the relay names accounts) and the
// current login of a GitHub user. A consent link names the id: GitHub gives a login that was
// given up to whoever takes it next.
func (c *Client) LookupAccount(ctx context.Context, login string) (uid, current string, err error) {
	if err := CheckAccount(login); err != nil {
		return "", "", err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", GitHubAPI+"/users/"+url.PathEscape(login), nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := c.httpClient().Do(req)
	if err != nil {
		return "", "", fmt.Errorf("looking up @%s on GitHub: %w", login, err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return "", "", fmt.Errorf("there is no GitHub account @%s", login)
	}
	if res.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("looking up @%s on GitHub: answered %d", login, res.StatusCode)
	}
	var u struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
		Type  string `json:"type"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&u); err != nil || u.ID <= 0 || CheckAccount(u.Login) != nil {
		return "", "", fmt.Errorf("looking up @%s on GitHub: unexpected answer", login)
	}
	if u.Type != "User" {
		return "", "", fmt.Errorf("@%s is not a person's GitHub account", u.Login)
	}
	return fmt.Sprintf("gh:%d", u.ID), u.Login, nil
}

// CheckAccount accepts a GitHub login.
func CheckAccount(login string) error {
	if !githubLogin.MatchString(login) {
		return fmt.Errorf("--account must be your GitHub login, like octocat")
	}
	return nil
}
