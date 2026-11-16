package gateway

import "testing"

// After a domain move the relay issues grants at its new origin. The robot accepts them once a
// signed relay answer named that origin (State.Issuer), and sends people there to sign in.
func TestIssuerFromSignedAnswer(t *testing.T) {
	const moved = "https://connect.new.example"
	f := newFixture(t, MowgliPolicy{})
	g := f.grant(func(c map[string]any) { c["iss"] = moved })
	if _, status := f.login(g); status == 200 || status == 204 {
		t.Fatalf("grant from an origin no signed answer named: accepted (%d)", status)
	}
	f.state.Issuer = moved
	f.gw.UpdateState(f.state)
	if tok, status := f.login(f.grant(func(c map[string]any) { c["iss"] = moved })); tok == "" {
		t.Fatalf("grant from the signed origin: refused (%d)", status)
	}
	if tok, _ := f.login(f.grant(nil)); tok == "" {
		t.Fatal("grant from the configured origin: refused")
	}
	if tok, _ := f.login(f.grant(func(c map[string]any) { c["iss"] = "https://evil.example" })); tok != "" {
		t.Fatal("grant from another origin: accepted")
	}
	r := f.req("GET", "/", map[string]string{"Accept": "text/html"}, "")
	if loc := r.Header.Get("Location"); loc != moved+"/open/"+testRobot {
		t.Fatalf("sign-in goes to %q, want the new origin", loc)
	}
}
