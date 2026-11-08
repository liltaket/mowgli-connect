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

// sessionFile is the on-disk format. Consumed grant ids are kept until they expire, so a grant
// cannot be redeemed again after an agent restart inside its acceptance window. (Older files
// were a bare list of sessions.)
type sessionFile struct {
	Sessions []storedSession  `json:"sessions"`
	Grants   map[string]int64 `json:"consumedGrants"` // jti -> unix time it may be forgotten
}

func (g *Gateway) loadSessions() {
	if g.cfg.SessionFile == "" {
		return
	}
	g.strictStart = true // until the previous run's consumed grants are known
	b, err := os.ReadFile(g.cfg.SessionFile)
	if err != nil {
		return
	}
	var f sessionFile
	if err := json.Unmarshal(b, &f); err != nil {
		if err := json.Unmarshal(b, &f.Sessions); err != nil {
			g.cfg.Logger.Warn("ignoring unreadable session file", "err", err)
			return
		}
	}
	now := g.cfg.Now()
	if f.Grants != nil && len(f.Grants) <= maxGrantIDs {
		g.strictStart = false
		for jti, until := range f.Grants {
			if exp := time.Unix(until, 0); now.Before(exp) {
				g.jtis[jti] = exp
			}
		}
	}
	for _, s := range f.Sessions {
		raw, err := hex.DecodeString(s.Hash)
		exp := time.Unix(s.Expires, 0)
		if err != nil || len(raw) != 32 || !now.Before(exp) || exp.After(now.Add(SessionTTL)) || roleRank(s.Role) == 0 {
			continue
		}
		var key [32]byte
		copy(key[:], raw)
		g.sessions[key] = &session{key: key, sub: s.Sub, name: s.Name, role: s.Role, epoch: s.Epoch, expires: exp}
	}
}

// persistLocked writes the session table and consumed grants atomically (mode 0600).
func (g *Gateway) persistLocked() error {
	if g.cfg.SessionFile == "" {
		return nil
	}
	f := sessionFile{Sessions: make([]storedSession, 0, len(g.sessions)), Grants: map[string]int64{}}
	for k, s := range g.sessions {
		f.Sessions = append(f.Sessions, storedSession{Hash: hex.EncodeToString(k[:]), Sub: s.sub, Name: s.name, Role: s.role, Epoch: s.epoch, Expires: s.expires.Unix()})
	}
	now := g.cfg.Now()
	for jti, exp := range g.jtis {
		if now.Before(exp) {
			f.Grants[jti] = exp.Unix()
		}
	}
	b, err := json.Marshal(f)
	if err == nil {
		err = writeFileAtomic(g.cfg.SessionFile, b)
	}
	if err != nil {
		g.cfg.Logger.Warn("persisting sessions", "err", err)
	}
	return err
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
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if d, err := os.Open(filepath.Dir(path)); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}
