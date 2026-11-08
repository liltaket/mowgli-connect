package relay

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A relay answering with a redirect must not make the agent request the redirect target.
func TestNoRedirectClient(t *testing.T) {
	hit := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	defer target.Close()
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/x", http.StatusFound)
	}))
	defer relay.Close()
	resp, err := NoRedirectClient(5 * time.Second).Get(relay.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound || hit {
		t.Fatalf("redirect followed: status %d, target hit %v", resp.StatusCode, hit)
	}
}
