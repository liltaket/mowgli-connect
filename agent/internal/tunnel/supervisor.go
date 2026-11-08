// Package tunnel supervises the cloudflared connector process.
package tunnel

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"sync"
	"time"
)

// Spec says how cloudflared should run. The zero value means "not running".
type Spec struct {
	Token    string // named tunnel: connector token from the relay
	QuickURL string // quick tunnel: local origin, e.g. http://127.0.0.1:4007
}

type Supervisor struct {
	Binary string // path to cloudflared
	Logger *slog.Logger
	// OnHostname is called (from a supervisor goroutine) with each quick-tunnel hostname
	// cloudflared reports, i.e. once per (re)start in quick mode.
	OnHostname func(string)

	mu     sync.Mutex
	spec   Spec
	cancel context.CancelFunc
	done   chan struct{}
}

var quickHost = regexp.MustCompile(`https://([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)`)

// Set starts, restarts or (with a zero Spec) stops cloudflared so that it runs with spec.
func (s *Supervisor) Set(spec Spec) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if spec == s.spec && (spec == Spec{} || s.cancel != nil) {
		return
	}
	s.startLocked(spec)
}

// Restart forces a new cloudflared process with the current spec (quick mode: new hostname).
func (s *Supervisor) Restart() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.startLocked(s.spec)
}

func (s *Supervisor) Stop() { s.Set(Spec{}) }

func (s *Supervisor) startLocked(spec Spec) {
	if s.cancel != nil {
		s.cancel()
		<-s.done
		s.cancel, s.done = nil, nil
	}
	s.spec = spec
	if spec == (Spec{}) {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel, s.done = cancel, make(chan struct{})
	go s.loop(ctx, spec, s.done)
}

func (s *Supervisor) loop(ctx context.Context, spec Spec, done chan struct{}) {
	defer close(done)
	backoff := time.Second
	for {
		start := time.Now()
		args := []string{"tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0"}
		env := os.Environ()
		if spec.Token != "" {
			// The connector token is passed via the environment, never argv (visible in ps).
			args = append(args, "run")
			env = append(env, "TUNNEL_TOKEN="+spec.Token)
		} else {
			args = append(args, "--url", spec.QuickURL)
		}
		cmd := exec.CommandContext(ctx, s.Binary, args...)
		cmd.Env = env
		cmd.Stdout = os.Stderr
		cmd.WaitDelay = 10 * time.Second
		var logs io.ReadCloser
		var err error
		if spec.Token == "" {
			logs, err = cmd.StderrPipe()
		} else {
			cmd.Stderr = os.Stderr
		}
		if err == nil {
			s.Logger.Info("starting cloudflared", "quick", spec.Token == "")
			err = cmd.Start()
		}
		if err == nil {
			if logs != nil {
				go s.scan(logs)
			}
			err = cmd.Wait()
		}
		if ctx.Err() != nil {
			s.Logger.Info("cloudflared stopped")
			return
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		s.Logger.Warn("cloudflared exited; restarting", "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Minute)
	}
}

// scan forwards cloudflared's log and reports the quick-tunnel hostname it announces.
func (s *Supervisor) scan(r io.Reader) {
	sc := bufio.NewScanner(r)
	reported := false
	for sc.Scan() {
		line := sc.Text()
		os.Stderr.WriteString(line + "\n")
		if m := quickHost.FindStringSubmatch(line); m != nil && m[1] != "api.trycloudflare.com" && !reported && s.OnHostname != nil {
			reported = true
			s.OnHostname(m[1])
		}
	}
}
