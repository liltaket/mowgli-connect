package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
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
		// Map tiles through the GUI's tile proxy: the z/x/y shape only (a query or escapes are
		// refused by AllowRequest, see TestTileRequests).
		{"GET", "/tiles/3/4/5", false, all},
		{"GET", "/tiles/3/4/5.png", false, all},
		{"GET", "/tiles/19/280000/170000.jpeg", false, all},
		{"HEAD", "/tiles/3/4/5.pbf", false, all},
		{"GET", "/tiles/3/4/5.webp", false, all},
		{"GET", "/tiles/3/4/5.mvt", false, all},
		{"GET", "/tiles/3/4/5.jpg", false, all},
		{"GET", "/tiles", false, ownerOnly},
		{"GET", "/tiles/", false, ownerOnly},
		{"GET", "/tiles/3/4", false, ownerOnly},
		{"GET", "/tiles/3/4/5/6", false, ownerOnly},
		{"GET", "/tiles/3/4/5/", false, ownerOnly},
		{"GET", "/tiles/a/4/5", false, ownerOnly},
		{"GET", "/tiles/-3/4/5", false, ownerOnly},
		{"GET", "/tiles/123/4/5", false, ownerOnly},
		{"GET", "/tiles/3/4/123456789", false, ownerOnly},
		{"GET", "/tiles/3/4/5.PNG", false, ownerOnly},
		{"GET", "/tiles/3/4/5.svg", false, ownerOnly},
		{"GET", "/tiles/3/4/5.png.json", false, ownerOnly},
		{"GET", "/tiles/3/4/5\n", false, ownerOnly},
		{"GET", "/tiles/3/4/5.png\n", false, ownerOnly},
		{"GET", "/tiles/vt/lyrs=s,h&x=1&y=2&z=3", false, ownerOnly},
		{"GET", "/tiles/admin/config", false, ownerOnly},
		{"GET", "/tiles/3/4/5", true, ownerOnly},
		{"POST", "/tiles/3/4/5", false, ownerOnly},
		{"PUT", "/tiles/3/4/5", false, ownerOnly},
		{"DELETE", "/tiles/3/4/5", false, ownerOnly},
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
		{"GET", "/api/map-backups", false, control},
		{"GET", "/api/map-backups/", false, ownerOnly},
		{"GET", "/api/map-backups/x", false, ownerOnly},
		{"GET", "/api/fleet/robots", false, ownerOnly},
		{"GET", "/api/new-endpoint", false, ownerOnly},
		// Running the mower: its calls (high_level_control and emergency are also checked by body,
		// see TestOperatorBodies), the map editor, schedules and map backups.
		{"POST", "/api/mowglinext/call/high_level_control", false, control},
		{"POST", "/api/mowglinext/call/emergency", false, control},
		{"POST", "/api/mowglinext/call/start_in_area", false, control},
		{"POST", "/api/mowglinext/call/coverage_clear_resume", false, control},
		{"POST", "/api/mowglinext/call/mow_enabled", false, control},
		{"POST", "/api/mowglinext/call/blade_control", false, control},
		{"POST", "/api/mowglinext/call/coverage_orientation", false, control},
		{"POST", "/api/mowglinext/call/clear_dig_escalation", false, control},
		{"POST", "/api/mowglinext/call/promote_obstacle", false, control},
		{"POST", "/api/mowglinext/call/ignore_obstacle", false, control},
		{"POST", "/api/mowglinext/call/discard_obstacle", false, control},
		{"POST", "/api/mowglinext/call/correct_recorded_obstacle", false, control},
		{"POST", "/api/mowglinext/call/preview_obstacle_clearance", false, control},
		{"POST", "/api/mowglinext/call/preview_coverage", false, control},
		{"POST", "/api/mowglinext/call/set_area_coverage_lines", false, control},
		{"POST", "/api/mowglinext/call/get_lidar_ignore_corridors", false, control},
		{"POST", "/api/mowglinext/call/set_lidar_ignore_corridors", false, control},
		{"POST", "/api/mowglinext/map/area/add", false, control},
		{"POST", "/api/mowglinext/map/docking", false, control},
		{"PUT", "/api/mowglinext/map", false, control},
		{"POST", "/api/schedules", false, control},
		{"PUT", "/api/schedules/1731312000000000000", false, control},
		{"PUT", "/api/schedules/a-b_C", false, control},
		{"DELETE", "/api/schedules/1731312000000000000", false, control},
		{"POST", "/api/map-backups", false, control},
		{"POST", "/api/map-backups/areas-20261111T092748.000Z.dat/restore", false, control},
		{"PUT", "/api/mowglinext/call/high_level_control", false, ownerOnly},
		{"DELETE", "/api/mowglinext/call/high_level_control", false, ownerOnly},
		{"GET", "/api/mowglinext/call/high_level_control", false, ownerOnly},
		// What stays with the owner: the robot and its account, not the mowing.
		{"POST", "/api/mowglinext/call/reboot_board", false, ownerOnly},
		{"POST", "/api/mowglinext/call/reset_firmware_param_store", false, ownerOnly},
		{"POST", "/api/mowglinext/call/fusion_graph_clear", false, ownerOnly},
		{"POST", "/api/mowglinext/call/fusion_graph_save", false, ownerOnly},
		{"POST", "/api/mowglinext/call/set_datum", false, ownerOnly},
		{"POST", "/api/mowglinext/call/start", false, ownerOnly},
		{"POST", "/api/mowglinext/call/HIGH_LEVEL_CONTROL", false, ownerOnly},
		{"POST", "/api/mowglinext/call/high_level_control/", false, ownerOnly},
		{"POST", "/api/mowglinext/call/high_level_control/x", false, ownerOnly},
		{"POST", "/api/mowglinext/call/", false, ownerOnly},
		{"POST", "/api/mowglinext/call", false, ownerOnly},
		{"DELETE", "/api/mowglinext/map", false, ownerOnly}, // delete the whole map
		{"POST", "/api/mowglinext/map", false, ownerOnly},
		{"PUT", "/api/mowglinext/map/docking", false, ownerOnly},
		{"PUT", "/api/schedules", false, ownerOnly},
		{"DELETE", "/api/schedules", false, ownerOnly},
		{"POST", "/api/schedules/1", false, ownerOnly},
		{"PUT", "/api/schedules/1/x", false, ownerOnly},
		{"PUT", "/api/schedules/", false, ownerOnly},
		{"PUT", "/api/schedules/a%2Fb", false, ownerOnly},
		{"PUT", "/api/schedules/a.b", false, ownerOnly},
		{"PUT", "/api/schedules/" + strings.Repeat("1", 65), false, ownerOnly},
		{"DELETE", "/api/map-backups/areas-20261111T092748.000Z.dat", false, ownerOnly},
		{"POST", "/api/map-backups/1/restore", false, ownerOnly},
		{"POST", "/api/map-backups/areas-20261111T092748.000Z.dat/restore/x", false, ownerOnly},
		{"POST", "/api/map-backups/../settings/restore", false, ownerOnly},
		{"POST", "/api/settings", false, ownerOnly},
		{"POST", "/api/settings/yaml", false, ownerOnly},
		{"POST", "/api/config/keys/set", false, ownerOnly},
		{"POST", "/api/config/keys/get", false, all}, // map display keys only, by body (TestReadableConfigKeys)
		{"GET", "/api/config/keys/get", false, ownerOnly},
		{"PUT", "/api/config/keys/get", false, ownerOnly},
		{"POST", "/api/params", false, ownerOnly},
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

// The joystick socket is for owners and operators, and only when the robot allows it.
func TestTeleopNeedsTheRobotsOptIn(t *testing.T) {
	for _, teleop := range []bool{false, true} {
		p := MowgliPolicy{AllowTeleop: teleop}
		for _, role := range []string{RoleOwner, RoleOperator, RoleViewer, "admin"} {
			want := teleop && (role == RoleOwner || role == RoleOperator)
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
		{hlc, `{"Command":3}`, true}, // record area
		{hlc, `{"Command":4}`, true},
		{hlc, `{"Command":5}`, true},   // finish recording
		{hlc, `{"Command":6}`, true},   // cancel recording
		{hlc, `{"Command":7}`, true},   // manual mowing
		{hlc, `{"Command":254}`, true}, // reset emergency
		{hlc, `{"Command":9}`, false},
		{hlc, `{"Command":253}`, false},
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
		{em, `{"Emergency":0}`, true}, // release
		{em, `{}`, false},             // a missing field would be read as a default by the GUI
		{em, `{"Emergency":2}`, false},
		{em, `{"Emergency":1,"Emergency":0}`, false},
		{em, `{"Emergency":256}`, false},
		{area, `{"area":0}`, true},
		{area, `{"area":3}`, true},
		{area, `{"area":255}`, true},
		{area, `{"area":256}`, false},
		{area, `{"area":1,"x":2}`, false},
		{fresh, `{}`, true},
		{fresh, ``, true},
		// Calls whose body is the app's own are passed on as sent.
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":0,"mow_direction":0}`, true},
		{"/api/mowglinext/call/mow_enabled", `{"mow_direction":0,"mow_enabled":0}`, true},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":1,"mow_direction":0}`, false}, // ON skips the tree's gate
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":1,"mow_direction":7}`, false},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":0}`, false},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":0,"mow_direction":1}`, false},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":0,"mow_enabled":1,"mow_direction":0}`, false},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":0,"mow_direction":0,"x":1}`, false},
		{"/api/mowglinext/call/mow_enabled", `{"Mow_Enabled":0,"mow_direction":0}`, false},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":0.0,"mow_direction":0}`, false},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":256,"mow_direction":0}`, false},
		{"/api/mowglinext/call/mow_enabled", `{"mow_enabled":0,"mow_direction":0}{}`, false},
		{"/api/mowglinext/call/mow_enabled", ``, false},
		{"/api/mowglinext/call/blade_control", `{"mow_enabled":1,"mow_direction":0}`, true},
		{"/api/schedules", `{"time":"08:00"}`, true},
		{"/api/mowglinext/map/docking", `{}`, true},
		{"/api/mowglinext/call/set_datum", `{}`, false}, // a route Allow does not let through
		{"/api/settings", `{}`, false},
		{"/api/mowglinext/call/", `{}`, false},
	} {
		r := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
		if got := (MowgliPolicy{}).AllowRequest(RoleOperator, r); got != tc.allow {
			t.Errorf("operator %s %s: allow=%v, want %v", tc.path, tc.body, got, tc.allow)
		}
		if tc.allow {
			if b, _ := io.ReadAll(r.Body); string(b) != tc.body || r.ContentLength != int64(len(tc.body)) {
				t.Errorf("%s %s: body %q (length %d) after the check", tc.path, tc.body, b, r.ContentLength)
			}
		}
		// Owners are not body-checked; viewers never pass a control, whatever Allow said.
		for role, want := range map[string]bool{RoleOwner: true, RoleViewer: false, "admin": false} {
			r := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
			if got := (MowgliPolicy{}).AllowRequest(role, r); got != want {
				t.Errorf("%s %s %s: allow=%v, want %v", role, tc.path, tc.body, got, want)
			}
			if b, _ := io.ReadAll(r.Body); string(b) != tc.body {
				t.Errorf("%s %s: body changed", role, tc.path)
			}
		}
	}
	if !(MowgliPolicy{}).AllowRequest(RoleOperator, httptest.NewRequest("GET", "/api/system/info", nil)) {
		t.Error("operator GET refused by the request check")
	}
}

// The tile proxy forwards the query and the path as sent to the tile server: for anyone but the
// owner, only a plain z/x/y path with no query.
func TestTileRequests(t *testing.T) {
	for _, tc := range []struct {
		target string
		allow  bool
	}{
		{"/tiles/3/4/5", true},
		{"/tiles/3/4/5.png", true},
		{"/tiles/3/4/5?", false},
		{"/tiles/3/4/5?x=1", false},
		{"/tiles/3/4/5.png?access_token=x", false},
		{"/tiles/3/4/5?url=http://169.254.169.254/", false},
		{"/tiles/%33/4/5", false},      // decodes to /tiles/3/4/5, but reaches the GUI escaped
		{"/tiles/3/4/5%2Epng", false},  // the same
		{"/api/system/info?x=1", true}, // only the tile proxy is checked here
	} {
		for role, want := range map[string]bool{RoleOwner: true, RoleOperator: tc.allow, RoleViewer: tc.allow} {
			for _, method := range []string{"GET", "HEAD"} {
				if got := (MowgliPolicy{}).AllowRequest(role, httptest.NewRequest(method, tc.target, nil)); got != want {
					t.Errorf("%s %s %s: allow=%v, want %v", role, method, tc.target, got, want)
				}
			}
		}
	}
}

// Viewers and operators may read the map page's display settings from the config store, with
// exactly the bodies the GUI's web app sends, and no other key: other keys hold credentials.
func TestReadableConfigKeys(t *testing.T) {
	const mapPage = `{"gui.map.offset.x":"","gui.map.offset.y":"","gui.map.display.bearing":"","gui.map.display.rotation_locked":""}`
	// What hooks/useSettings.ts asks for on every page: stays owner-only.
	const settings = `{"system.api.addr":"","system.api.webDirectory":"","system.map.enabled":"","system.map.tileServer":"",` +
		`"system.map.tileUri":"","system.mower.configFile":"","system.mqtt.enabled":"","system.mqtt.host":"","system.mqtt.prefix":"",` +
		`"system.homekit.enabled":"","system.homekit.pincode":"","system.ros.nodeName":"","system.ros.masterUri":"","system.ros.nodeHost":""}`
	for _, tc := range []struct {
		body  string
		allow bool
	}{
		{mapPage, true},
		{`{"map.obstacleOriginals":""}`, true},
		{`{"gui.map.offset.x":""}`, true},
		{` { "gui.map.display.bearing" : "" } ` + "\n", true},
		{`{"gui.map.offset.x":""}`, true}, // the same key, escaped: every parser decodes it alike
		{settings, false},
		{`{"system.homekit.pincode":""}`, false},
		{`{"system.map.tileServer":""}`, false},
		{`{"gui.firmware.config":""}`, false},
		{`{"gui.map.offset.x":"","system.homekit.pincode":""}`, false},
		{`{"GUI.map.offset.x":""}`, false},
		{`{"gui.map.offset.x ":""}`, false},
		{`{"gui.map.offset.x":"","gui.map.offset.x":""}`, false},
		{`{"gui.map.offset.x":"1"}`, false},
		{`{"gui.map.offset.x":null}`, false},
		{`{"gui.map.offset.x":0}`, false},
		{`{"gui.map.offset.x":{}}`, false},
		{`{"gui.map.offset.x":[""]}`, false},
		{`{"gui.map.offset.x":""}{"system.homekit.pincode":""}`, false},
		{`{"gui.map.offset.x":""}x`, false},
		{`{"gui.map.offset.x":"",}`, false},
		{`[{"gui.map.offset.x":""}]`, false},
		{`{}`, false},
		{``, false},
		{`{"gui.map.offset.x":""` + strings.Repeat(" ", maxCallBody) + `}`, false},
	} {
		for role, want := range map[string]bool{RoleOwner: true, RoleOperator: tc.allow, RoleViewer: tc.allow, "admin": false} {
			r := httptest.NewRequest("POST", "/api/config/keys/get", strings.NewReader(tc.body))
			if got := (MowgliPolicy{}).AllowRequest(role, r); got != want {
				t.Errorf("%s %s: allow=%v, want %v", role, tc.body, got, want)
			}
			if b, _ := io.ReadAll(r.Body); want && (string(b) != tc.body || r.ContentLength != int64(len(tc.body))) {
				t.Errorf("%s %s: body %q (length %d) after the check", role, tc.body, b, r.ContentLength)
			}
		}
	}
	// Writing those keys stays the owner's.
	for _, role := range []string{RoleOperator, RoleViewer} {
		if (MowgliPolicy{}).Allow(role, "POST", "/api/config/keys/set", false) {
			t.Errorf("%s may write config keys", role)
		}
	}
}

// End to end through the gateway: an operator session can run the mower and nothing that
// changes the robot or its settings, and the GUI receives exactly the checked body.
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
		{"POST", "/api/mowglinext/call/set_datum", `{}`},
		{"POST", "/api/mowglinext/call/reboot_board", `{}`},
		{"POST", "/api/mowglinext/call/mow_enabled", `{"mow_enabled":1,"mow_direction":7}`},
		{"POST", "/api/settings", `{}`},
		{"GET", "/api/settings", ``},
		{"POST", "/api/system/reboot", ``},
		{"POST", "/api/config/keys/set", `{"gui.map.offset.x":"1"}`},
		{"DELETE", "/api/mowglinext/map", ``},
	} {
		if r := f.req(tc.method, tc.path, h, tc.body); r.StatusCode != 403 {
			t.Errorf("operator %s %s %s: %d", tc.method, tc.path, tc.body, r.StatusCode)
		}
	}
	// The rest of running the mower goes through unchanged: release the emergency stop, the
	// blade, the map editor and schedules.
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/mowglinext/call/high_level_control", `{"Command":254}`},
		{"POST", "/api/mowglinext/call/emergency", `{"Emergency":0}`},
		{"POST", "/api/mowglinext/call/blade_control", `{"mow_enabled":1,"mow_direction":0}`},
		{"POST", "/api/mowglinext/call/mow_enabled", `{"mow_enabled":0,"mow_direction":0}`},
		{"PUT", "/api/mowglinext/map", `{"areas":[]}`},
		{"POST", "/api/schedules", `{"time":"08:00"}`},
		{"DELETE", "/api/schedules/12", ``},
	} {
		r := f.req(tc.method, tc.path, h, tc.body)
		var echo map[string]string
		if r.StatusCode != 200 || json.NewDecoder(r.Body).Decode(&echo) != nil || echo["body"] != tc.body {
			t.Errorf("operator %s %s %s: %d %v", tc.method, tc.path, tc.body, r.StatusCode, echo)
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
	// Telemetry, and the joystick because AllowTeleop is on.
	for _, p := range []string{"/api/mowglinext/multiplex", "/api/mowglinext/publish/cmd_vel"} {
		c, _, err := f.dialWS(p, tok, "https://"+testHost)
		if err != nil {
			t.Fatalf("operator %s: %v", p, err)
		}
		c.Close()
	}
	off := newFixture(t, MowgliPolicy{})
	otok, _ := off.login(off.grant(func(c map[string]any) { c["sub"] = "gh:3"; c["role"] = RoleOperator }))
	if _, resp, err := off.dialWS("/api/mowglinext/publish/cmd_vel", otok, "https://"+testHost); err == nil || resp.StatusCode != 403 {
		t.Fatal("operator got the joystick socket on a robot that does not allow it")
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

// End to end: a viewer gets the map page's settings and plain tiles, nothing else of either.
func TestViewerMapInGateway(t *testing.T) {
	f := newFixture(t, MowgliPolicy{})
	tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:2"; c["role"] = RoleViewer }))
	h := map[string]string{"Cookie": cookie(tok), "Origin": "https://" + testHost, "Content-Type": "application/json"}
	const body = `{"gui.map.offset.x":"","gui.map.offset.y":"","gui.map.display.bearing":"","gui.map.display.rotation_locked":""}`
	r := f.req("POST", "/api/config/keys/get", h, body)
	var echo map[string]string
	if r.StatusCode != 200 || json.NewDecoder(r.Body).Decode(&echo) != nil || echo["body"] != body {
		t.Fatalf("viewer map settings: %d %v", r.StatusCode, echo)
	}
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/config/keys/get", `{"system.homekit.pincode":""}`},
		{"POST", "/api/config/keys/set", `{"gui.map.offset.x":"1"}`},
		{"GET", "/tiles/3/4/5.png?x=1", ``},
		{"GET", "/tiles/vt/lyrs=s,h&x=1&y=2&z=3", ``},
	} {
		if r := f.req(tc.method, tc.path, h, tc.body); r.StatusCode != 403 {
			t.Errorf("viewer %s %s %s: %d", tc.method, tc.path, tc.body, r.StatusCode)
		}
	}
	if r := f.req("GET", "/tiles/3/4/5.png", h, ""); r.StatusCode != 200 {
		t.Errorf("viewer tile: %d", r.StatusCode)
	}
	// The CSRF check applies to the read as to any POST.
	bad := map[string]string{"Cookie": cookie(tok), "Origin": "https://evil.example.com"}
	if r := f.req("POST", "/api/config/keys/get", bad, body); r.StatusCode != 403 {
		t.Fatalf("cross-origin config read: %d", r.StatusCode)
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

// Written out by hand, not derived from the policy's own tables: what an operator must never
// reach, by any method, through Allow and then AllowRequest with the bodies the GUI would take.
func TestOperatorNeverReachesTheRobot(t *testing.T) {
	var paths []string
	for _, c := range []string{"set_datum", "fusion_graph_save", "fusion_graph_clear", "fusion_graph_clear_lidar_map",
		"reboot_board", "reset_firmware_param_store", "unknown", "High_Level_Control", " high_level_control", "high_level_control%2f"} {
		paths = append(paths, "/api/mowglinext/call/"+c)
	}
	paths = append(paths, "/api/settings", "/api/settings/yaml", "/api/settings/status", "/api/settings/schema", "/api/settings/yaml/defaults",
		"/api/settings/gnss/apply", "/api/settings/gnss/runtime-config", "/api/config/keys/set", "/api/config/envs", "/api/params",
		"/api/system/reboot", "/api/system/shutdown", "/api/system/updater/apply", "/api/system/updates", "/api/containers/", "/api/containers/x/restart",
		"/api/setup/flashBoard", "/api/firmware/available", "/api/calibration/imu-yaw", "/api/tools/drive/pid-tuning/start", "/api/tools/rosbag/start",
		"/api/tools/blackbox/save", "/api/diagnostics/sessions", "/api/diagnostics/snapshot", "/api/remote-access/settings", "/api/remote-access/apply",
		"/api/notifications/settings", "/api/notifications/test", "/api/fleet/peers", "/api/fleet/robots/x/call/high_level_control",
		"/api/import/openmower", "/api/irrisense/settings", "/api/mowglinext/map/", "/api/mowglinext/map/area", "/api/drive", "/api",
		"/swagger/index.html", "/api/schedules/a/b", "/api/map-backups/x", "/api/map-backups/restore")
	pol := MowgliPolicy{AllowTeleop: true}
	for _, p := range paths {
		for _, m := range []string{"POST", "PUT", "DELETE", "PATCH"} { // reads: TestMowgliPolicyRoles
			for _, body := range []string{"", "{}", `{"command":1}`, `{"mow_enabled":0,"mow_direction":0}`} {
				r := httptest.NewRequest(m, "/", strings.NewReader(body))
				r.URL.Path = p
				if pol.Allow(RoleOperator, m, p, false) && pol.AllowRequest(RoleOperator, r) {
					t.Errorf("operator %s %s %q allowed", m, p, body)
				}
			}
		}
	}
	// The whole map in one step, and every other way to run a command the GUI does not offer.
	for _, body := range []string{`{"Command":255}`, `{"command":255}`} {
		r := httptest.NewRequest("POST", callPrefix+"high_level_control", strings.NewReader(body))
		if (MowgliPolicy{}).AllowRequest(RoleOperator, r) {
			t.Errorf("operator command 255: %s", body)
		}
	}
	if pol.Allow(RoleOperator, "DELETE", "/api/mowglinext/map", false) {
		t.Error("operator may delete the whole map")
	}
}

// An operator's open joystick socket ends when the member list downgrades them to viewer.
func TestOperatorJoystickEndsOnDowngrade(t *testing.T) {
	f := newFixture(t, MowgliPolicy{AllowTeleop: true})
	tok, _ := f.login(f.grant(func(c map[string]any) { c["sub"] = "gh:3"; c["role"] = RoleOperator }))
	c, _, err := f.dialWS("/api/mowglinext/publish/cmd_vel", tok, "https://"+testHost)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	f.state.Members["gh:3"] = RoleViewer
	f.gw.UpdateState(f.state)
	_ = c.SetReadDeadline(time.Now().Add(wsAuthRecheck + 3*time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			if !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
				t.Fatalf("joystick socket ended with %v, want a policy close", err)
			}
			return
		}
	}
}
