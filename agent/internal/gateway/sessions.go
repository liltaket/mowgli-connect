package gateway

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type storedSession struct {
	Hash    string `json:"hash"` // SHA-256 of the cookie value; the cookie itself is never stored
	Sub     string `json:"sub"`
	Name    string `json:"name"`
	Role    string `json:"role"`
	Epoch   int64  `json:"epoch"`
	Expires int64  `json:"expires"`
}

func (g *Gateway) loadSessions() {
	if g.cfg.SessionFile == "" {
		return
	}
	b, err := os.ReadFile(g.cfg.SessionFile)
	if err != nil {
		return
	}
	var list []storedSession
	if err := json.Unmarshal(b, &list); err != nil {
		g.cfg.Logger.Warn("ignoring unreadable session file", "err", err)
		return
	}
	now := g.cfg.Now()
	for _, s := range list {
		raw, err := hex.DecodeString(s.Hash)
		exp := time.Unix(s.Expires, 0)
		if err != nil || len(raw) != 32 || !now.Before(exp) || exp.After(now.Add(SessionTTL)) || roleRank(s.Role) == 0 {
			continue
		}
		var key [32]byte
		copy(key[:], raw)
		g.sessions[key] = &session{sub: s.Sub, name: s.Name, role: s.Role, epoch: s.Epoch, expires: exp}
	}
}

// persistLocked writes the session table atomically (mode 0600). Errors only cost convenience.
func (g *Gateway) persistLocked() {
	if g.cfg.SessionFile == "" {
		return
	}
	list := make([]storedSession, 0, len(g.sessions))
	for k, s := range g.sessions {
		list = append(list, storedSession{Hash: hex.EncodeToString(k[:]), Sub: s.sub, Name: s.name, Role: s.role, Epoch: s.epoch, Expires: s.expires.Unix()})
	}
	b, err := json.Marshal(list)
	if err == nil {
		err = writeFileAtomic(g.cfg.SessionFile, b)
	}
	if err != nil {
		g.cfg.Logger.Warn("persisting sessions", "err", err)
	}
}

func writeFileAtomic(path string, b []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".sessions-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
