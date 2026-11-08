package gateway

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ContainerGuard keeps a remote user from cutting off remote access by accident. The MowgliNext
// GUI can stop any Docker container (POST /api/containers/<id>/stop). Stopping the Mowgli
// Connect container or the GUI's own from a distance leaves nothing running that could start
// them again, so the robot stays unreachable until someone is at it. Restart is fine (both come
// back), and every other container can still be stopped.
type ContainerGuard struct {
	Upstream *url.URL     // the GUI, whose container list maps ids to names
	Client   *http.Client // nil = a client with a short timeout
	SelfID   string       // this container's id ("" if unknown)
	Names    []string     // protected container names, e.g. mowgli-connect, mowgli-gui

	mu      sync.Mutex
	ids     map[string]bool
	fetched time.Time
}

var containerStop = regexp.MustCompile(`^/api/containers/([^/]+)/stop/?$`)

// Denies reports whether this request would stop a protected container. When the GUI's
// container list cannot be read, every stop is refused rather than risk the lockout.
func (c *ContainerGuard) Denies(method, path string) bool {
	m := containerStop.FindStringSubmatch(path)
	if method != http.MethodPost || m == nil {
		return false
	}
	id := strings.TrimPrefix(m[1], "/")
	if id == "" {
		return true
	}
	for _, n := range c.Names {
		if id == n {
			return true
		}
	}
	if c.SelfID != "" && len(id) >= 12 && strings.HasPrefix(c.SelfID, id) {
		return true
	}
	ids, ok := c.protectedIDs()
	if !ok {
		return true
	}
	for full := range ids {
		if len(id) >= 12 && strings.HasPrefix(full, id) {
			return true
		}
	}
	return false
}

func (c *ContainerGuard) protectedIDs() (map[string]bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ids != nil && time.Since(c.fetched) < time.Minute {
		return c.ids, true
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	u := *c.Upstream
	u.Path, u.RawQuery = "/api/containers/", ""
	resp, err := client.Get(u.String())
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	var body struct {
		Containers []struct {
			ID    string   `json:"id"`
			Names []string `json:"names"`
		} `json:"containers"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&body) != nil {
		return nil, false
	}
	ids := map[string]bool{}
	for _, ct := range body.Containers {
		for _, n := range ct.Names {
			for _, p := range c.Names {
				if strings.TrimPrefix(n, "/") == p && len(ct.ID) >= 12 {
					ids[ct.ID] = true
				}
			}
		}
	}
	c.ids, c.fetched = ids, time.Now()
	return ids, true
}

var mountedContainerID = regexp.MustCompile(`/containers/([0-9a-f]{64})/`)

// OwnContainerID reads this container's id from the files Docker mounts into it (hostname,
// resolv.conf), or "" outside Docker.
func OwnContainerID() string {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return ""
	}
	if m := mountedContainerID.FindSubmatch(b); m != nil {
		return string(m[1])
	}
	return ""
}
