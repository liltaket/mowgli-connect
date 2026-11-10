package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Policy decides whether an authenticated request may reach the upstream app.
// It runs after authentication, Host and Origin checks.
type Policy interface {
	Allow(role, method, path string, websocket bool) bool
}

// BodyPolicy is implemented by a Policy whose decision for some routes depends on the request
// body. AllowBody runs after Allow; it may read the body and must leave the same bytes in place.
type BodyPolicy interface {
	AllowBody(role string, r *http.Request) bool
}

const (
	RoleOwner    = "owner"
	RoleOperator = "operator" // "Can control": mowing controls, nothing that changes the robot
	RoleViewer   = "viewer"
)

// roleRank orders the roles. An unknown role ranks 0 and is never authorized, so a relay that
// sends a role this agent does not know (a newer one) gets no access rather than a guess.
func roleRank(r string) int {
	switch r {
	case RoleOwner:
		return 3
	case RoleOperator:
		return 2
	case RoleViewer:
		return 1
	}
	return 0
}

// minRole returns the less privileged of two roles ("" if either is unknown).
func minRole(a, b string) string {
	if roleRank(a) == 0 || roleRank(b) == 0 {
		return ""
	}
	if roleRank(a) < roleRank(b) {
		return a
	}
	return b
}

func safeMethod(m string) bool { return m == "GET" || m == "HEAD" }

// GenericPolicy: owners may do anything; viewers may only read (no WebSockets). Operators get
// viewer rights: in an unknown app the agent cannot tell a control from a settings change.
type GenericPolicy struct{}

func (GenericPolicy) Allow(role, method, path string, ws bool) bool {
	switch role {
	case RoleOwner:
		return true
	case RoleOperator, RoleViewer:
		return safeMethod(method) && !ws
	}
	return false
}

// MowgliPolicy encodes the MowgliNext GUI surface (docs/research/mowgli-gui-traffic.md).
type MowgliPolicy struct {
	// AllowTeleop permits the joystick publish socket (/api/mowglinext/publish/*) for owners.
	// Off by default: remote manual driving over the internet has unvalidated latency.
	AllowTeleop bool
}

// Viewers get the app itself plus an explicit allow list of read-only API endpoints. A deny
// list is not enough: several GUI endpoints (e.g. /api/settings) return unredacted
// configuration including credentials, and new endpoints appear with GUI updates.
var mowgliViewerAPI = map[string]bool{
	"/api/system/info": true, "/api/system/versions": true, "/api/schedules": true, "/api/weather": true,
}

var mowgliViewerSockets = []string{"/api/mowglinext/multiplex", "/api/mowglinext/subscribe/"}

// Operators get what viewers get plus these ROS service calls, the GUI's mowing controls
// (gui/web/src/pages/MowgliNextPage.tsx, MapPage.tsx, components/MowerActions.tsx at
// mowglinext 8d78819). Exact paths only: the GUI's router is case-sensitive and does not
// rewrite them. The two calls whose argument selects what happens are also checked by body
// (AllowBody); everything else (settings, maps, schedules, containers, updates, firmware,
// calibration, tuning, diagnostics, fleet, remote access, the joystick) stays owner-only.
var mowgliOperatorCalls = map[string]bool{
	"/api/mowglinext/call/high_level_control":    true, // body: start/continue, dock, pause/stop
	"/api/mowglinext/call/emergency":             true, // body: engage only
	"/api/mowglinext/call/start_in_area":         true, // mow one area now
	"/api/mowglinext/call/coverage_clear_resume": true, // "Start fresh": forget the interrupted run
}

// highLevelCommands are the HighLevelControl commands an operator may send
// (ros2/src/mowgli_interfaces/srv/HighLevelControl.srv). Not area recording (3-6), manual mow
// (7), emergency reset (254) or COMMAND_DELETE_MAPS (255).
var highLevelCommands = map[uint64]bool{1: true /* START */, 2: true /* HOME */, 8: true /* STOP */}

func hasAnyPrefix(p string, prefixes []string) bool {
	for _, x := range prefixes {
		if p == strings.TrimSuffix(x, "/") || strings.HasPrefix(p, x) {
			return true
		}
	}
	return false
}

func (m MowgliPolicy) Allow(role, method, path string, ws bool) bool {
	if ws && strings.HasPrefix(path, "/api/mowglinext/publish/") && (!m.AllowTeleop || role != RoleOwner) {
		return false
	}
	switch role {
	case RoleOwner:
		return true
	case RoleOperator, RoleViewer:
		if ws {
			return method == "GET" && hasAnyPrefix(path, mowgliViewerSockets)
		}
		if !safeMethod(method) {
			return role == RoleOperator && method == http.MethodPost && mowgliOperatorCalls[path]
		}
		if path == "/api" || strings.HasPrefix(path, "/api/") {
			return mowgliViewerAPI[path]
		}
		return !hasAnyPrefix(path, []string{"/swagger/"})
	}
	return false
}

// maxCallBody bounds the operator call bodies read for AllowBody; the GUI's own are a few bytes.
const maxCallBody = 1024

func (m MowgliPolicy) AllowBody(role string, r *http.Request) bool {
	if role != RoleOperator || safeMethod(r.Method) {
		return true
	}
	switch r.URL.Path {
	case "/api/mowglinext/call/high_level_control":
		return bodyHasOnly(r, []string{"command", "Command"}, func(v uint64) bool { return highLevelCommands[v] })
	case "/api/mowglinext/call/emergency":
		// Engage only. Releasing the latch stays with the owner, like the joystick.
		return bodyHasOnly(r, []string{"emergency", "Emergency"}, func(v uint64) bool { return v == 1 })
	case "/api/mowglinext/call/start_in_area":
		return bodyHasOnly(r, []string{"area", "Area"}, func(uint64) bool { return true })
	case "/api/mowglinext/call/coverage_clear_resume":
		return true // the GUI ignores the body
	}
	return false // a route Allow let through that this check does not know
}

// bodyHasOnly reads a small request body and reports whether it is exactly one JSON object with
// a single member, named by one of names (the GUI's field tag, and the casing its web app sends,
// both matched by the GUI's encoding/json decoder), whose value is a plain unsigned 8-bit
// integer literal that ok accepts. Anything else is refused: with a single, unambiguous member
// no JSON parser can read another value, or a default zero, from the same bytes. The body is put
// back for the proxy byte for byte.
func bodyHasOnly(r *http.Request, names []string, ok func(uint64) bool) bool {
	if r.Body == nil {
		return false
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, maxCallBody+1))
	r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(b))
	r.ContentLength, r.TransferEncoding = int64(len(b)), nil
	r.Header.Del("Transfer-Encoding")
	if err != nil || len(b) > maxCallBody {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return false
	}
	t, err := dec.Token()
	key, isStr := t.(string)
	if err != nil || !isStr || !contains(names, key) {
		return false
	}
	t, err = dec.Token()
	num, isNum := t.(json.Number)
	if err != nil || !isNum || strings.ContainsAny(string(num), ".eE+-") {
		return false
	}
	v, err := strconv.ParseUint(string(num), 10, 8)
	if err != nil {
		return false
	}
	if t, err := dec.Token(); err != nil || t != json.Delim('}') {
		return false
	}
	if _, err := dec.Token(); err != io.EOF {
		return false
	}
	return ok(v)
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
