package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"mowgli-connect/agent/internal/pin"
	"mowgli-connect/agent/internal/relay"
)

const (
	pinFile  = "relay-pin.json" // the pinned relay keys and the relay origin in use
	holdFile = "updates-paused" // present while the relay's operator holds back agent updates
)

// trust tracks which relay keys the robot trusts and which relay origin it uses (package pin).
type trust struct {
	path, configured string
	allowHTTP        bool
	pin              *pin.Pin
	log              *slog.Logger
}

func loadTrust(dataDir, configured string, allowHTTP bool, log *slog.Logger) (*trust, error) {
	path := filepath.Join(dataDir, pinFile)
	p, err := pin.Load(path)
	if err != nil {
		return nil, fmt.Errorf("%w (to trust the relay's current key instead, run: connect-agent forget-relay-key)", err)
	}
	t := &trust{path: path, configured: configured, allowHTTP: allowHTTP, pin: p, log: log}
	if p != nil && p.Configured != configured {
		// The owner changed MC_RELAY_URL on the robot: that is their decision, and the relay
		// there must still answer with a pinned key.
		log.Info("MC_RELAY_URL changed on the robot; using it (the relay keys stay pinned)", "relay", configured, "was", p.Origin)
		p.Configured, p.Origin = configured, configured
		if err := pin.Save(path, p); err != nil {
			return nil, err
		}
	}
	return t, nil
}

// origin is the relay origin to use.
func (t *trust) origin() string {
	if t.pin != nil && t.pin.Origin != "" {
		return t.pin.Origin
	}
	return t.configured
}

func (t *trust) keys() []relay.RelayKey {
	if t.pin == nil {
		return nil
	}
	return t.pin.Keys
}

// issuer is the relay origin a signed answer named (for the gateway); "" while nothing is pinned.
func (t *trust) issuer() string {
	if t.pin == nil {
		return ""
	}
	return t.origin()
}

func (t *trust) save() {
	if err := pin.Save(t.path, t.pin); err != nil {
		t.log.Error("saving the pinned relay keys", "err", err)
	}
}

// accept pins the relay keys of a verified answer: on first contact, and when an answer signed by
// a pinned key lists other keys (a key rotation).
func (t *trust) accept(s *relay.Self, sg *relay.Signed, origin string) {
	if sg == nil {
		return // unsigned: accepted only while nothing is pinned (a relay from before signed answers)
	}
	keys := pin.Valid(s.RelayKeys)
	if len(keys) == 0 {
		t.log.Warn("a signed relay answer lists no usable key; keeping the pinned ones")
		return
	}
	switch {
	case t.pin == nil:
		t.pin = &pin.Pin{Keys: keys, Origin: origin, Configured: t.configured}
		t.log.Info("relay key pinned: from now on only answers signed by it are accepted", "kids", kids(keys), "relay", origin)
	case !pin.Same(t.pin.Keys, keys):
		t.log.Info("relay keys changed, in an answer signed by a pinned key", "kids", kids(keys), "was", kids(t.pin.Keys))
		t.pin.Keys = keys
	default:
		return
	}
	t.save()
}

// afterSync handles a successful answer: it pins keys, and follows a signed domain move once the
// new origin answers with a pinned key. It returns the answer to use.
func (t *trust) afterSync(ctx context.Context, client *relay.Client, s *relay.Self, sg *relay.Signed) (*relay.Self, *relay.Signed) {
	t.accept(s, sg, client.Origin)
	client.Pinned = t.keys()
	if sg == nil || sg.Origin == "" || sg.Origin == client.Origin {
		return s, sg
	}
	if err := pin.CheckOrigin(sg.Origin, t.allowHTTP); err != nil {
		t.log.Warn("ignoring the relay's new address", "origin", sg.Origin, "err", err)
		return s, sg
	}
	probe := *client
	probe.Origin = sg.Origin
	s2, sg2, err := probe.Self(ctx)
	if err == nil && (sg2 == nil || sg2.Origin != sg.Origin) {
		err = errors.New("its answer is not signed for that address")
	}
	if err != nil {
		t.log.Warn("the relay says it moved, but the new address does not answer correctly yet; staying", "from", client.Origin, "to", sg.Origin, "err", err)
		return s, sg
	}
	t.accept(s2, sg2, sg.Origin)
	t.log.Info("relay moved to a new address (signed by the pinned relay key)", "from", client.Origin, "to", sg.Origin)
	client.Origin, client.Pinned = sg.Origin, t.keys()
	t.pin.Origin = sg.Origin
	t.save()
	return s2, sg2
}

func kids(keys []relay.RelayKey) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k.Kid)
	}
	return out
}

// setUpdateHold keeps the relay's update pause on disk, where "connect-agent updates" (run by
// the robot's update.sh with docker exec) reads it.
func setUpdateHold(dataDir string, paused bool, log *slog.Logger) {
	path := filepath.Join(dataDir, holdFile)
	_, err := os.Stat(path)
	switch {
	case paused && errors.Is(err, os.ErrNotExist):
		if err := os.WriteFile(path, []byte("paused by the relay operator\n"), 0o600); err != nil {
			log.Error("recording the update pause", "err", err)
			return
		}
		log.Info("agent updates paused by the relay operator")
	case !paused && err == nil:
		if err := os.Remove(path); err != nil {
			log.Error("clearing the update pause", "err", err)
			return
		}
		log.Info("agent updates resumed by the relay operator")
	}
}
