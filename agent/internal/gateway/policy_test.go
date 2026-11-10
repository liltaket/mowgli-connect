package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Every role against every kind of route. "unknown" stands for any role this agent does not
// know, such as one a newer relay sends: it must get nothing.
func TestMowgliPolicyRoles(t *testing.T) {
	type want struct{ owner, operator, viewer bool }
	all, none := want{true, true, true}, want{}
	ownerOnly, control := want{owner: true}, want{owner: true, operator: true}
	for _, tc := range []struct {
		method, path string
		ws           bool
		want         want
	}{
		// The app itself and the read-only API.
		{"GET", "/", false, all},
		{"GET", "/assets/index-abc.js", false, all},
		{"HEAD", "/", false, all},
		{"GET", "/api/system/info", false, all},
		{"GET", "/api/system/versions", false, all},
		{"GET", "/api/schedules", false, all},
		{"GET", "/api/weather", false, all},
		{"GET", "/swagger/index.html", false, ownerOnly},
		// Reads that return configuration, credentials or private data.
		{"GET", "/api", false, ownerOnly},
		{"GET", "/api/settings", false, ownerOnly},
		{"GET", "/api/settings/yaml", false, ownerOnly},
		{"GET", "/api/config/envs", false, ownerOnly},
		{"GET", "/api/params", false, ownerOnly},
		{"GET", "/api/remote-access/settings", false, ownerOnly},
		{"GET", "/api/notifications/settings", false, ownerOnly},
		{"GET", "/api/diagnostics/snapshot", false, ownerOnly},
		{"GET", "/api/tools/rosbag/download/x", false, ownerOnly},
		{"GET", "/api/map-backups", false, ownerOnly},
		{"GET", "/api/fleet/robots", false, ownerOnly},
		{"GET", "/api/new-endpoint", false, ownerOnly},
		// Mowing controls (the body is checked separately, see TestOperatorBodies).
		{"POST", "/api/mowglinext/call/high_level_control", false, control},
		{"POST", "/api/mowglinext/call/emergency", false, control},
		{"POST", "/api/mowglinext/call/start_in_area", false, control},
		{"POST", "/api/mowglinext/call/coverage_clear_resume", false, control},
		{"PUT", "/api/mowglinext/call/high_level_control", false, ownerOnly},
		{"DELETE", "/api/mowglinext/call/high_level_control", false, ownerOnly},
		// Everything else that changes the robot.
		{"POST", "/api/mowglinext/call/mow_enabled", false, ownerOnly},
		{"POST", "/api/mowglinext/call/blade_control", false, ownerOnly},
		{"POST", "/api/mowglinext/call/clear_dig_escalation", false, ownerOnly},
		{"POST", "/api/mowglinext/call/reboot_board", false, ownerOnly},
		{"POST", "/api/mowglinext/call/reset_firmware_param_store", false, ownerOnly},
		{"POST", "/api/mowglinext/call/fusion_graph_clear", false, ownerOnly},
		{"POST", "/api/mowglinext/call/promote_obstacle", false, ownerOnly},
		{"POST", "/api/mowglinext/call/set_datum", false, ownerOnly},
		{"POST", "/api/mowglinext/call/start", false, ownerOnly},
		{"POST", "/api/mowglinext/call/", false, ownerOnly},
		{"POST", "/api/mowglinext/map/area/add", false, ownerOnly},
		{"POST", "/api/mowglinext/map/docking", false, ownerOnly},
		{"DELETE", "/api/mowglinext/map", false, ownerOnly},
		{"PUT", "/api/mowglinext/map", false, ownerOnly},
		{"POST", "/api/settings", false, ownerOnly},
		{"POST", "/api/settings/yaml", false, ownerOnly},
		{"POST", "/api/config/keys/set", false, ownerOnly},
		{"POST", "/api/config/keys/get", false, ownerOnly},
		{"POST", "/api/params", false, ownerOnly},
		{"POST", "/api/schedules", false, ownerOnly},
		{"PUT", "/api/schedules/1", false, ownerOnly},
		{"DELETE", "/api/schedules/1", false, ownerOnly},
		{"POST", "/api/containers/abc/restart", false, ownerOnly},
		{"POST", "/api/system/reboot", false, ownerOnly},
		{"POST", "/api/system/updater/apply", false, ownerOnly},
		{"POST", "/api/setup/flashBoard", false, ownerOnly},
		{"POST", "/api/settings/gnss/apply", false, ownerOnly},
		{"PUT", "/api/remote-access/settings", false, ownerOnly},
		{"PUT", "/api/fleet/coordination", false, ownerOnly},
		{"POST", "/api/fleet/robots/x/call/high_level_control", false, ownerOnly},
		{"POST", "/api/tools/rosbag/start", false, ownerOnly},
		{"POST", "/api/tools/drive/pid-tuning/start", false, ownerOnly},
		{"POST", "/api/calibration/imu-yaw", false, ownerOnly},
		{"POST", "/api/diagnostics/sessions", false, ownerOnly},
		{"POST", "/api/map-backups/1/restore", false, ownerOnly},
		{"POST", "/api/import/openmower", false, ownerOnly},
		{"PUT", "/api/notifications/settings", false, ownerOnly},
		{"POST", "/", false, ownerOnly},
		// WebSockets: telemetry for everyone, container logs for the owner. The joystick is
		// tested below (it also depends on AllowTeleop).
		{"GET", "/api/mowglinext/multiplex", true, all},
		{"GET", "/api/mowglinext/subscribe/status", true, all},
		{"GET", "/api/containers/abc/logs", true, ownerOnly},
		{"POST", "/api/mowglinext/multiplex", true, ownerOnly},
		{"GET", "/api/mowglinext/call/high_level_control", true, ownerOnly},
		{"GET", "/", true, ownerOnly},
	} {
		for _, teleop := range []bool{false, true} {
			p := MowgliPolicy{AllowTeleop: teleop}
			for role, allowed := range map[string]bool{RoleOwner: tc.want.owner, RoleOperator: tc.want.operator, RoleViewer: tc.want.viewer,
				"admin": none.owner, "": false, "Owner": false, "operator ": false} {
				if got := p.Allow(role, tc.method, tc.path, tc.ws); got != allowed {
					t.Errorf("teleop=%v %q %s %s ws=%v: allow=%v, want %v", teleop, role, tc.method, tc.path, tc.ws, got, allowed)
				}
			}
		}
	}
}

// The joystick socket is the owner's only, and only when the robot allows it.
func TestTeleopIsOwnerOnly(t *testing.T) {
	for _, teleop := range []bool{false, true} {
		p := MowgliPolicy{AllowTeleop: teleop}
		for _, role := range []string{RoleOwner, RoleOperator, RoleViewer, "admin"} {
			want := teleop && role == RoleOwner
			if got := p.Allow(role, "GET", "/api/mowglinext/publish/cmd_vel", true); got != want {
				t.Errorf("teleop=%v %s: allow=%v, want %v", teleop, role, got, want)
			}
		}
	}
}

// In an unknown app the agent cannot tell controls from settings, so operators only read.
func TestGenericPolicyRoles(t *testing.T) {
	p := GenericPolicy{}
	for _, tc := range []struct {
		method string
		ws     bool
		owner  bool
		reader bool
	}{
		{"GET", false, true, true},
		{"HEAD", false, true, true},
		{"POST", false, true, false},
		{"PUT", false, true, false},
		{"DELETE", false, true, false},
		{"GET", true, true, false},
	} {
		for role, want := range map[string]bool{RoleOwner: tc.owner, RoleOperator: tc.reader, RoleViewer: tc.reader, "admin": false, "": false} {
			if got := p.Allow(role, tc.method, "/x", tc.ws); got != want {
				t.Errorf("%q %s ws=%v: allow=%v, want %v", role, tc.method, tc.ws, got, want)
			}
		}
	}
}

func TestRoleRankAndMinRole(t *testing.T) {
	if !(roleRank(RoleOwner) > roleRank(RoleOperator) && roleRank(RoleOperator) > roleRank(RoleViewer) && roleRank(RoleViewer) > 0) {
		t.Fatal("roles out of order")
	}
	for _, tc := range [][3]string{
		{RoleOwner, RoleOperator, RoleOperator},
		{RoleOperator, RoleOwner, RoleOperator},
		{RoleOperator, RoleViewer, RoleViewer},
		{RoleViewer, RoleOperator, RoleViewer},
		{RoleOperator, RoleOperator, RoleOperator},
		{RoleOperator, "admin", ""},
		{"admin", RoleOwner, ""},
		{"", RoleViewer, ""},
	} {
		if got := minRole(tc[0], tc[1]); got != tc[2] {
			t.Errorf("minRole(%q, %q) = %q, want %q", tc[0], tc[1], got, tc[2])
		}
	}
}

// The two calls whose argument decides what happens accept exactly the GUI's own requests for
// the mowing controls, in a form no JSON parser can read differently.
func TestOperatorBodies(t *testing.T) {
	const hlc, em, area, fresh = "/api/mowglinext/call/high_level_control", "/api/mowglinext/call/emergency",
		"/api/mowglinext/call/start_in_area", "/api/mowglinext/call/coverage_clear_resume"
	for _, tc := range []struct {
		path, body string
		allow      bool
	}{
		{hlc, `{"Command":1}`, true}, // start, continue
		{hlc, `{"Command":2}`, true}, // dock
		{hlc, `{"Command":8}`, true}, // pause, stop
		{hlc, `{"command":8}`, true},
		{hlc, ` { "Command" : 1 } ` + "\n", true},
		{hlc, `{"Command":3}`, false},   // record area
		{hlc, `{"Command":5}`, false},   // finish recording
		{hlc, `{"Command":6}`, false},   // cancel recording
		{hlc, `{"Command":7}`, false},   // manual mowing
		{hlc, `{"Command":254}`, false}, // reset emergency
		{hlc, `{"Command":255}`, false}, // delete maps
		{hlc, `{"Command":0}`, false},
		{hlc, `{"Command":257}`, false}, // 257 & 0xff would be 1
		{hlc, `{"Command":1.0}`, false},
		{hlc, `{"Command":1e0}`, false},
		{hlc, `{"Command":-1}`, false},
		{hlc, `{"Command":"1"}`, false},
		{hlc, `{"Command":true}`, false},
		{hlc, `{"Command":null}`, false},
		{hlc, `{"Command":[1]}`, false},
		{hlc, `{"COMMAND":1}`, false},               // encoding/json would match it; only the known spellings pass
		{hlc, `{"\u0043ommand":1}`, true},           // the same key, escaped: every parser decodes it alike
		{hlc, `{"Command":1,"command":255}`, false}, // duplicate keys: parsers disagree on which wins
		{hlc, `{"Command":1,"Command":255}`, false},
		{hlc, `{"Command":1,"x":1}`, false},
		{hlc, `{"Command":1}{"Command":255}`, false},
		{hlc, `{"Command":1}x`, false},
		{hlc, `[{"Command":1}]`, false},
		{hlc, `{}`, false},
		{hlc, ``, false},
		{hlc, `{"Command":1` + strings.Repeat(" ", maxCallBody) + `}`, false},
		{em, `{"Emergency":1}`, true},
		{em, `{"emergency":1}`, true},
		{em, `{"Emergency":0}`, false}, // releasing the emergency stop stays with the owner
		{em, `{}`, false},              // the GUI would decode a missing field as 0, a release
		{em, `{"Emergency":1,"Emergency":0}`, false},
		{em, `{"Emergency":256}`, false},
		{area, `{"area":0}`, true},
		{area, `{"area":3}`, true},
		{area, `{"area":255}`, true},
		{area, `{"area":256}`, false},
		{area, `{"area":1,"x":2}`, false},
		{fresh, `{}`, true},
		{fresh, ``, true},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":1}`, false}, // unknown to AllowBody: refused
	} {
		r := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
		if got := (MowgliPolicy{}).AllowBody(RoleOperator, r); got != tc.allow {
			t.Errorf("operator %s %s: allow=%v, want %v", tc.path, tc.body, got, tc.allow)
		}
		if tc.allow {
			if b, _ := io.ReadAll(r.Body); string(b) != tc.body || r.ContentLength != int64(len(tc.body)) {
				t.Errorf("%s %s: body %q (length %d) after the check", tc.path, tc.body, b, r.ContentLength)
			}
		}
		// Owners and readers are not body-checked (Allow already decided for them).
		for _, role := range []string{RoleOwner, RoleViewer} {
			r := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
			if !(MowgliPolicy{}).AllowBody(role, r) {
				t.Errorf("%s %s %s: refused", role, tc.path, tc.body)
			}
			if b, _ := io.ReadAll(r.Body); string(b) != tc.body {
				t.Errorf("%s %s: body changed", role, tc.path)
			}
		}
	}
	if !(MowgliPolicy{}).AllowBody(RoleOperator, httptest.NewRequest("GET", "/api/system/info", nil)) {
		t.Error("operator GET refused by the body check")
	}
}

// End to end through the gateway: an operator session can use the mowing controls and nothing
// that changes the robot, and the GUI receives exactly the checked body.
func TestOperatorInGateway(t *testing.T) {
	f := newFixture(t, MowgliPolicy{AllowTeleop: true})
	tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:3"; c["role"] = RoleOperator }))
	if tok == "" {
		t.Fatal("operator login failed")
	}
	h := map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost, "Content-Type": "application/json"}
	r := f.req("POST", "/api/mowglinext/call/high_level_control", h, `{"Command":2}`)
	var echo map[string]string
	if r.StatusCode != 200 || json.NewDecoder(r.Body).Decode(&echo) != nil || echo["body"] != `{"Command":2}` {
		t.Fatalf("operator dock: %d %v", r.StatusCode, echo)
	}
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/mowglinext/call/high_level_control", `{"Command":255}`},
		{"POST", "/api/mowglinext/call/emergency", `{"Emergency":0}`},
		{"POST", "/api/mowglinext/call/blade_control", `{"mow_enabled":1,"mow_direction":0}`},
		{"POST", "/api/settings", `{}`},
		{"GET", "/api/settings", ``},
		{"POST", "/api/system/reboot", ``},
		{"POST", "/api/schedules", `{}`},
		{"DELETE", "/api/mowglinext/map", ``},
	} {
		if r := f.req(tc.method, tc.path, h, tc.body); r.StatusCode != 403 {
			t.Errorf("operator %s %s %s: %d", tc.method, tc.path, tc.body, r.StatusCode)
		}
	}
	// Spellings a router might normalize to a control never reach the GUI.
	for _, p := range []string{"/api/mowglinext/call/high_level_control/", "/api/mowglinext/call//high_level_control",
		"/api/mowglinext/call/./high_level_control", "/api/mowglinext/call/x/../high_level_control",
		"/api/mowglinext/call%2Fhigh_level_control", "/api/mowglinext/call/HIGH_LEVEL_CONTROL", "/api/mowglinext/call/high_level_control%00"} {
		if r := f.req("POST", p, h, `{"Command":1}`); r.StatusCode != 403 && r.StatusCode != 400 {
			t.Errorf("operator POST %s: %d", p, r.StatusCode)
		}
	}
	// Telemetry yes, the joystick no (even with AllowTeleop on).
	c, _, err := f.dialWS("/api/mowglinext/multiplex", tok, "https://"+testHost)
	if err != nil {
		t.Fatalf("operator multiplex: %v", err)
	}
	c.Close()
	if _, resp, err := f.dialWS("/api/mowglinext/publish/cmd_vel", tok, "https://"+testHost); err == nil || resp.StatusCode != 403 {
		t.Fatal("operator got the joystick socket")
	}
	// The CSRF check still applies to the controls.
	bad := map[string]string{"Cookie": cookie(tok), "Origin": "https://evil.example.com"}
	if r := f.req("POST", "/api/mowglinext/call/high_level_control", bad, `{"Command":8}`); r.StatusCode != 403 {
		t.Fatalf("cross-origin operator control: %d", r.StatusCode)
	}

	// Downgraded to viewer at the next sync: the controls stop, reading goes on.
	f.state.Members["gh:3"] = RoleViewer
	f.gw.UpdateState(f.state)
	if r := f.req("POST", "/api/mowglinext/call/high_level_control", h, `{"Command":8}`); r.StatusCode != 403 {
		t.Fatalf("downgraded operator still controls: %d", r.StatusCode)
	}
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 200 {
		t.Fatalf("downgraded operator cannot read: %d", r.StatusCode)
	}
	// Removed: the session ends.
	delete(f.state.Members, "gh:3")
	f.gw.UpdateState(f.state)
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 401 {
		t.Fatalf("removed operator still signed in: %d", r.StatusCode)
	}
}

// A viewer cannot use the controls even with the GUI's exact body.
func TestViewerCannotControl(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:2"; c["role"] = RoleViewer }))
	h := map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost}
	for _, p := range []string{"/api/mowglinext/call/high_level_control", "/api/mowglinext/call/emergency"} {
		if r := f.req("POST", p, h, `{"Command":1}`); r.StatusCode != 403 {
			t.Errorf("viewer POST %s: %d", p, r.StatusCode)
		}
	}
}

// An agent that does not know a role (as an agent from before "operator" sees it) gives that
// person nothing: no session from a grant, and an existing session ends when the member list
// changes their role to it.
func TestUnknownRoleFailsClosed(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	f.state.Members["gh:9"] = "superuser"
	f.gw.UpdateState(f.state)
	for _, role := range []string{"superuser", RoleOwner, RoleViewer} {
		if tok, status := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:9"; c["role"] = role })); tok != "" || status != http.StatusUnauthorized {
			t.Errorf("member with an unknown role, grant %q: session %q, status %d", role, tok, status)
		}
	}
	// A grant naming an unknown role, for a known member.
	if tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:2"; c["role"] = "superuser" })); tok != "" {
		t.Error("grant with an unknown role accepted")
	}
	tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:3"; c["role"] = RoleOperator }))
	h := map[string]string{"Cookie": cookie(tok)}
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 200 {
		t.Fatalf("operator read: %d", r.StatusCode)
	}
	f.state.Members["gh:3"] = "superuser"
	f.gw.UpdateState(f.state)
	if r := f.req("GET", "/api/system/info", h, ""); r.StatusCode != 401 {
		t.Fatalf("session kept after its role became unknown: %d", r.StatusCode)
	}
}

// A grant with a higher role than the member list knows (the owner just changed "View only" to
// "Can control") makes the agent sync first, so the new role works without waiting for a poll.
// Without a sync the session is capped at the listed role.
func TestRoleUpgradeResyncs(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	calls := 0
	f.gw.cfg.Resync = func() {
		calls++
		st := f.state
		st.Members = map[string]string{"gh:1": RoleOwner, "gh:2": RoleOperator}
		f.gw.UpdateState(st)
	}
	tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:2"; c["role"] = RoleOperator }))
	h := map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost}
	if r := f.req("POST", "/api/mowglinext/call/high_level_control", h, `{"Command":1}`); calls != 1 || r.StatusCode != 200 {
		t.Fatalf("upgrade: %d resyncs, control %d", calls, r.StatusCode)
	}

	g := newFixture(t, MowgliPolicy{}) // no resync available: capped by the list
	tok, _ = g.login(g.grant(func(c map[string]any) { c["sub"] = "gh:2"; c["role"] = RoleOperator }))
	h["Cookie"] = cookie(tok)
	if r := g.req("POST", "/api/mowglinext/call/high_level_control", h, `{"Command":1}`); r.StatusCode != 403 {
		t.Fatalf("viewer controls with an operator grant: %d", r.StatusCode)
	}
}
