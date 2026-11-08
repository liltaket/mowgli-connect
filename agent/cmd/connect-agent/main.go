// Command connect-agent runs next to an app on a robot and makes it reachable through a
// Cloudflare Tunnel, behind Mowgli Connect authentication. See docs/protocol.md.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"time"

	"mowgli-connect/agent/internal/gateway"
	"mowgli-connect/agent/internal/identity"
	"mowgli-connect/agent/internal/jws"
	"mowgli-connect/agent/internal/relay"
	"mowgli-connect/agent/internal/state"
	"mowgli-connect/agent/internal/tunnel"
)

var version = "dev"

type config struct {
	relayURL, listen, upstream, dataDir, name, profile, cloudflared string
	tunnelMode                                                      string
	cloudflaredWrap                                                 []string
	allowTeleop, wsCompression                                      bool
	maxBodyMB                                                       int64
	maxStale, poll                                                  time.Duration
	throttle                                                        map[string]time.Duration
}

// The relay runs on Cloudflare Workers Free (100,000 requests/day for the whole account), so
// robots poll it rarely: a claimed robot every MC_POLL_INTERVAL (480 requests/day at 3m), an
// unclaimed one every 5 s only in the first unclaimedFastFor after start, then every minute.
const (
	unclaimedFastPoll = 5 * time.Second
	unclaimedSlowPoll = time.Minute
	unclaimedFastFor  = 30 * time.Minute
)

const defaultThrottle = "mowProgress=2s,lidarMap=2s,lidar=200ms"

// parseThrottle reads "topic=interval,..." ("off" disables throttling).
func parseThrottle(s string) (map[string]time.Duration, error) {
	m := map[string]time.Duration{}
	if s == "off" {
		return m, nil
	}
	for _, part := range strings.Split(s, ",") {
		topic, iv, ok := strings.Cut(strings.TrimSpace(part), "=")
		d, err := time.ParseDuration(iv)
		if !ok || topic == "" || err != nil || d <= 0 || d > time.Minute {
			return nil, fmt.Errorf("MC_THROTTLE: bad entry %q (want topic=interval, e.g. %s, or off)", part, defaultThrottle)
		}
		m[topic] = d
	}
	return m, nil
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	v, err := strconv.ParseBool(env(k, strconv.FormatBool(def)))
	if err != nil {
		return def
	}
	return v
}

func loadConfig() (config, error) {
	host, _ := os.Hostname()
	c := config{
		relayURL:      strings.TrimRight(env("MC_RELAY_URL", ""), "/"),
		listen:        env("MC_LISTEN", "127.0.0.1:4007"),
		upstream:      env("MC_UPSTREAM", "http://127.0.0.1:4006"),
		dataDir:       env("MC_DATA_DIR", "/data"),
		name:          env("MC_ROBOT_NAME", host),
		profile:       env("MC_PROFILE", "mowgli"),
		cloudflared:   env("MC_CLOUDFLARED", "cloudflared"),
		tunnelMode:    env("MC_TUNNEL_MODE", "named"),
		allowTeleop:   envBool("MC_ALLOW_TELEOP", false),
		wsCompression: envBool("MC_WS_COMPRESSION", true),
	}
	mb, err := strconv.ParseInt(env("MC_MAX_BODY_MB", "64"), 10, 64)
	if err != nil || mb <= 0 {
		return c, errors.New("MC_MAX_BODY_MB must be a positive integer")
	}
	c.maxBodyMB = mb
	if c.maxStale, err = time.ParseDuration(env("MC_MAX_STALE", "10m")); err != nil || c.maxStale < 2*time.Minute {
		return c, errors.New("MC_MAX_STALE must be a duration of at least 2m (e.g. 10m)")
	}
	if c.poll, err = time.ParseDuration(env("MC_POLL_INTERVAL", "3m")); err != nil || c.poll < 30*time.Second || 2*c.poll > c.maxStale {
		return c, errors.New("MC_POLL_INTERVAL must be at least 30s and at most half of MC_MAX_STALE (default 3m)")
	}
	if c.throttle, err = parseThrottle(env("MC_THROTTLE", defaultThrottle)); err != nil {
		return c, err
	}
	u, err := url.Parse(c.relayURL)
	if c.relayURL == "" || err != nil || u.Host == "" || u.Path != "" {
		return c, errors.New("MC_RELAY_URL must be an origin like https://connect.example.com")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && envBool("MC_INSECURE_RELAY", false)) {
		return c, errors.New("MC_RELAY_URL must use https (MC_INSECURE_RELAY=true only for local development)")
	}
	// MC_CLOUDFLARED_USER=uid:gid runs cloudflared as its own user, with every capability
	// dropped, so egress rules can tell it apart from the agent (set by the container image).
	if u := env("MC_CLOUDFLARED_USER", ""); u != "" {
		uid, gid, ok := strings.Cut(u, ":")
		if _, e1 := strconv.Atoi(uid); !ok || e1 != nil {
			return c, errors.New("MC_CLOUDFLARED_USER must be uid:gid")
		}
		if _, e2 := strconv.Atoi(gid); e2 != nil {
			return c, errors.New("MC_CLOUDFLARED_USER must be uid:gid")
		}
		c.cloudflaredWrap = []string{"setpriv", "--reuid=" + uid, "--regid=" + gid, "--clear-groups",
			"--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--"}
	}
	if c.tunnelMode != "named" && c.tunnelMode != "quick" {
		return c, fmt.Errorf("MC_TUNNEL_MODE must be named or quick, got %q", c.tunnelMode)
	}
	if c.profile != "mowgli" && c.profile != "generic" {
		return c, fmt.Errorf("MC_PROFILE must be mowgli or generic, got %q", c.profile)
	}
	return c, nil
}

func main() {
	cmd := "run"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "run":
		err = run()
	case "status":
		err = status()
	case "version":
		fmt.Println(version)
	default:
		err = fmt.Errorf("usage: connect-agent [run|status|version]")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect-agent:", err)
		os.Exit(1)
	}
}

func paths(dataDir string) (key, st, pairing string) {
	return filepath.Join(dataDir, "robot.key"), filepath.Join(dataDir, "state.json"), filepath.Join(dataDir, "pairing.json")
}

func toGatewayState(s *relay.Self, log *slog.Logger) gateway.State {
	gs := gateway.State{Status: s.Status, Hostname: s.Hostname, Epoch: s.SessionEpoch,
		RelayKeys: map[string]ed25519.PublicKey{}, Members: map[string]string{}}
	for _, k := range s.RelayKeys {
		pub, err := jws.DecodeKey(k.PublicKey)
		if err != nil || k.Kid == "" {
			log.Warn("ignoring malformed relay key", "kid", k.Kid)
			continue
		}
		gs.RelayKeys[k.Kid] = pub
	}
	for _, m := range s.Members {
		gs.Members[m.UserID] = m.Role
	}
	return gs
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	keyPath, statePath, pairingPath := paths(cfg.dataDir)
	key, err := identity.LoadOrCreate(keyPath)
	if err != nil {
		return err
	}
	robotID := identity.RobotID(key.Public().(ed25519.PublicKey))
	log.Info("mowgli connect agent", "version", version, "robotId", robotID, "relay", cfg.relayURL, "upstream", cfg.upstream)

	upstream, err := url.Parse(cfg.upstream)
	if err != nil || upstream.Host == "" {
		return fmt.Errorf("bad MC_UPSTREAM %q", cfg.upstream)
	}
	var policy gateway.Policy = gateway.GenericPolicy{}
	if cfg.profile == "mowgli" {
		policy = gateway.MowgliPolicy{AllowTeleop: cfg.allowTeleop}
	}
	// Resync requests from the gateway; each carries a channel closed after the next sync.
	syncReq := make(chan chan struct{}, 8)
	gwCfg := gateway.Config{
		RelayOrigin: cfg.relayURL, RobotID: robotID, Upstream: upstream, Policy: policy,
		MaxBodyBytes: cfg.maxBodyMB << 20, WSCompression: cfg.wsCompression, MaxStale: cfg.maxStale, Logger: log,
		SessionFile: filepath.Join(cfg.dataDir, "sessions.json"),
		Resync: func() {
			done := make(chan struct{})
			select {
			case syncReq <- done:
			default:
				return
			}
			select {
			case <-done:
			case <-time.After(10 * time.Second):
			}
		},
	}
	if cfg.profile == "mowgli" {
		gwCfg.ThrottlePath, gwCfg.Throttle = "/api/mowglinext/multiplex", cfg.throttle
	}
	gw := gateway.New(gwCfg)
	// Quick mode: cloudflared announces a new random hostname on every start; the latest one
	// waits here until it has been reported to the relay.
	hostCh := make(chan string, 1)
	sup := &tunnel.Supervisor{Binary: cfg.cloudflared, Wrap: cfg.cloudflaredWrap, Logger: log, OnHostname: func(h string) {
		select {
		case <-hostCh:
		default:
		}
		hostCh <- h
	}}
	defer sup.Stop()
	quick := cfg.tunnelMode == "quick"

	var current *relay.Self
	apply := func(s *relay.Self) {
		if current != nil && reflect.DeepEqual(current, s) {
			return
		}
		current = s
		gw.UpdateState(toGatewayState(s, log))
		if s.Status == "claimed" && (quick || s.TunnelToken != "") {
			if quick {
				sup.Set(tunnel.Spec{QuickURL: "http://" + cfg.listen})
			} else {
				sup.Set(tunnel.Spec{Token: s.TunnelToken})
			}
			if err := state.Save(statePath, s); err != nil {
				log.Error("saving state", "err", err)
			}
		} else {
			sup.Stop()
			_ = state.Remove(statePath)
		}
		log.Info("relay state applied", "status", s.Status, "hostname", s.Hostname, "epoch", s.SessionEpoch, "members", len(s.Members))
	}
	if cached, err := state.Load(statePath); err != nil {
		log.Warn("ignoring unreadable state cache", "err", err)
	} else if cached != nil && cached.RobotID == robotID {
		apply(cached)
	}

	host, _, err := net.SplitHostPort(cfg.listen)
	if err != nil {
		return fmt.Errorf("bad MC_LISTEN: %w", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		log.Warn("MC_LISTEN is not a loopback address; only cloudflared needs to reach the agent", "listen", cfg.listen)
	}
	srv := &http.Server{Addr: cfg.listen, Handler: gw, ReadHeaderTimeout: 15 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	teleop := "off"
	if cfg.allowTeleop {
		teleop = "on"
	}
	client := &relay.Client{Origin: cfg.relayURL, Key: key, RobotID: robotID,
		Agent: fmt.Sprintf("version=%s; teleop=%s", agentVersionToken(version), teleop)}
	if !quick && cfg.listen != "127.0.0.1:4007" {
		log.Warn("named tunnels deliver to 127.0.0.1:4007 (the relay's AGENT_ORIGIN); with another MC_LISTEN they answer 502", "listen", cfg.listen)
	}
	var pairing *relay.Registration
	backoff := 5 * time.Second
	pendingHost, healthFails := "", 0
	health := time.NewTicker(2 * time.Minute)
	defer health.Stop()
	started := time.Now()
	var syncWaiters []chan struct{}
	// Two independent schedules: the relay is polled (/self) when nextPoll is due or the
	// gateway asked for a resync; a pending quick-tunnel hostname is reported when nextReport is
	// due. Health checks wake the loop without triggering either.
	var nextPoll, nextReport time.Time
	for {
		if pendingHost != "" && current != nil && current.Status == "claimed" && !time.Now().Before(nextReport) {
			if s, err := client.ReportHostname(ctx, pendingHost); err != nil {
				log.Warn("reporting quick-tunnel hostname", "err", err)
				nextReport = time.Now().Add(10 * time.Second)
			} else {
				log.Info("quick tunnel ready", "url", "https://"+pendingHost+"/")
				pendingHost, healthFails = "", 0
				apply(s)
				gw.MarkFresh()
			}
		}
		if !time.Now().Before(nextPoll) || len(syncWaiters) > 0 {
			wait := cfg.poll
			unclaimedWait := unclaimedSlowPoll
			if time.Since(started) < unclaimedFastFor {
				unclaimedWait = unclaimedFastPoll
			}
			self, err := client.Self(ctx)
			switch {
			case err == nil && self.Status == "claimed":
				apply(self)
				gw.MarkFresh()
				if pairing != nil {
					log.Info("robot paired", "hostname", self.Hostname)
					pairing = nil
					_ = os.Remove(pairingPath)
				}
				backoff = 5 * time.Second
			case err == nil || errors.Is(err, relay.ErrUnknownRobot):
				if self != nil {
					apply(self)
					gw.MarkFresh()
				}
				if pairing == nil || time.Now().Unix() > pairing.ExpiresAt-30 {
					pairing, err = client.Register(ctx, cfg.name)
					if errors.Is(err, relay.ErrAlreadyClaimed) {
						pairing = nil
						wait = unclaimedSlowPoll
						break
					}
					if err != nil {
						log.Error("registering with relay", "err", err, "retry", backoff)
						pairing = nil
						wait = backoff
						backoff = min(backoff*2, 5*time.Minute)
						break
					}
					backoff = 5 * time.Second
					printPairing(pairing)
					if b, err := json.Marshal(pairing); err == nil {
						_ = os.WriteFile(pairingPath, b, 0o600)
					}
				}
				wait = unclaimedWait
			default:
				log.Warn("relay unreachable; keeping last known state", "err", err, "retry", backoff)
				wait = backoff
				backoff = min(backoff*2, 5*time.Minute)
			}
			nextPoll = time.Now().Add(wait)
			if current == nil || current.Status != "claimed" {
				// No tunnel runs now: a hostname a previous cloudflared announced is stale.
				pendingHost = ""
				select {
				case <-hostCh:
				default:
				}
			}
			for _, d := range syncWaiters {
				close(d)
			}
			syncWaiters = nil
		}
		select {
		case d := <-syncReq:
			syncWaiters = append(syncWaiters, d)
			for len(syncReq) > 0 {
				syncWaiters = append(syncWaiters, <-syncReq)
			}
		case <-ctx.Done():
			shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return srv.Shutdown(shutdown)
		case err := <-errc:
			return err
		case h := <-hostCh:
			pendingHost, nextReport = h, time.Time{}
		case <-health.C:
			if quick && pendingHost == "" && current != nil && current.Hostname != "" {
				if selfCheck(ctx, current.Hostname) {
					healthFails = 0
				} else if healthFails++; healthFails >= 3 {
					log.Warn("quick tunnel unreachable; restarting cloudflared")
					healthFails = 0
					sup.Restart()
				}
			}
		case <-time.After(time.Until(wake(nextPoll, nextReport, pendingHost != "" && current != nil && current.Status == "claimed"))):
		}
	}
}

// agentVersionToken keeps the version safe for a header token.
func agentVersionToken(v string) string {
	out := []rune{}
	for _, r := range v {
		if r < 128 && (r == '.' || r == '-' || r == '+' || r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') && len(out) < 40 {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return "unknown"
	}
	return string(out)
}

// wake returns the earliest due deadline: the relay poll, or the hostname report while one is
// pending.
func wake(nextPoll, nextReport time.Time, reportPending bool) time.Time {
	if reportPending && nextReport.Before(nextPoll) {
		return nextReport
	}
	return nextPoll
}

// selfCheck fetches the agent's own health endpoint through the public tunnel.
func selfCheck(ctx context.Context, hostname string) bool {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+hostname+"/_connect/healthz", nil)
	if err != nil {
		return false
	}
	resp, err := relay.NoRedirectClient(20 * time.Second).Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusNoContent
}

func printPairing(p *relay.Registration) {
	fmt.Fprintf(os.Stderr, `
================ Mowgli Connect: pair this robot ================
  Code:    %s   (valid until %s)
  Open:    %s
  Sign in and enter the code to link this robot to your account.
==================================================================

`, p.PairingCode, time.Unix(p.ExpiresAt, 0).Format("15:04"), p.ClaimURL)
}

func status() error {
	dataDir := env("MC_DATA_DIR", "/data")
	keyPath, statePath, pairingPath := paths(dataDir)
	if _, err := os.Stat(keyPath); err != nil {
		return fmt.Errorf("no robot identity in %s yet (start the agent first)", dataDir)
	}
	key, err := identity.LoadOrCreate(keyPath)
	if err != nil {
		return err
	}
	fmt.Println("robot id:", identity.RobotID(key.Public().(ed25519.PublicKey)))
	if s, err := state.Load(statePath); err == nil && s != nil {
		fmt.Printf("status:   %s\nurl:      https://%s/\nmembers:  %d\n", s.Status, s.Hostname, len(s.Members))
		return nil
	}
	var p relay.Registration
	if b, err := os.ReadFile(pairingPath); err == nil && json.Unmarshal(b, &p) == nil && time.Now().Unix() < p.ExpiresAt {
		printPairing(&p)
		return nil
	}
	fmt.Println("status:   not paired (no valid pairing code; check agent logs)")
	return nil
}
