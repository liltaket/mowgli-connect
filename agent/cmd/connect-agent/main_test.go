package main

import "testing"

func TestAgentHeader(t *testing.T) {
	for _, c := range []struct {
		version     string
		teleop, sim bool
		want        string
	}{
		{"main-abc1234", false, false, "version=main-abc1234; teleop=off"},
		{"main-abc1234", true, false, "version=main-abc1234; teleop=on"},
		{"main-abc1234", false, true, "version=main-abc1234; teleop=off; sim=1"},
		{"1.2.3 <x>", true, true, "version=1.2.3x; teleop=on; sim=1"},
		{"", false, false, "version=unknown; teleop=off"},
	} {
		if got := agentHeader(c.version, c.teleop, c.sim); got != c.want {
			t.Errorf("agentHeader(%q, %v, %v) = %q, want %q", c.version, c.teleop, c.sim, got, c.want)
		}
	}
}

func TestSimulatorConfig(t *testing.T) {
	t.Setenv("MC_RELAY_URL", "https://connect.example.com")
	for _, c := range []struct {
		env  string
		want bool
	}{
		{"", false}, // default: a real robot
		{"true", true},
		{"1", true},
		{"false", false},
		{"nonsense", false}, // unparsable falls back to the default
	} {
		t.Setenv("MC_SIMULATOR", c.env)
		cfg, err := loadConfig()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.simulator != c.want {
			t.Errorf("MC_SIMULATOR=%q: simulator = %v, want %v", c.env, cfg.simulator, c.want)
		}
	}
}
