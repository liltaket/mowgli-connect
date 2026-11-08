package gateway

import "strings"

// Policy decides whether an authenticated request may reach the upstream app.
// It runs after authentication, Host and Origin checks.
type Policy interface {
	Allow(role, method, path string, websocket bool) bool
}

const (
	RoleOwner  = "owner"
	RoleViewer = "viewer"
)

func roleRank(r string) int {
	switch r {
	case RoleOwner:
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

// GenericPolicy: owners may do anything; viewers may only read (no WebSockets).
type GenericPolicy struct{}

func (GenericPolicy) Allow(role, method, path string, ws bool) bool {
	switch role {
	case RoleOwner:
		return true
	case RoleViewer:
		return safeMethod(method) && !ws
	}
	return false
}

// MowgliPolicy encodes the MowgliNext GUI surface (docs/research/mowgli-gui-traffic.md).
type MowgliPolicy struct {
	// AllowTeleop permits the joystick publish socket (/api/mowglinext/publish/*).
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

func hasAnyPrefix(p string, prefixes []string) bool {
	for _, x := range prefixes {
		if p == strings.TrimSuffix(x, "/") || strings.HasPrefix(p, x) {
			return true
		}
	}
	return false
}

func (m MowgliPolicy) Allow(role, method, path string, ws bool) bool {
	if ws && strings.HasPrefix(path, "/api/mowglinext/publish/") && !m.AllowTeleop {
		return false
	}
	switch role {
	case RoleOwner:
		return true
	case RoleViewer:
		if ws {
			return method == "GET" && hasAnyPrefix(path, mowgliViewerSockets)
		}
		if !safeMethod(method) {
			return false
		}
		if path == "/api" || strings.HasPrefix(path, "/api/") {
			return mowgliViewerAPI[path]
		}
		return !hasAnyPrefix(path, []string{"/swagger/"})
	}
	return false
}
