// mc-delegate lets an AI agent or an automation act for one person on Mowgli Connect, within a
// delegation that person approved (docs/agent-delegation.md). The private key stays in a file of
// mode 600 in the profile directory; this program never prints it.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"

	"mowgli-connect/delegate/internal/client"
	"mowgli-connect/delegate/internal/mcp"
)

var version = "dev"

const usage = `Usage: mc-delegate [--profile NAME] <command> [arguments]

Commands:
  init [--relay URL]                    create this profile's key (once)
  request --account LOGIN --name NAME --scopes LIST [--ttl 24h] [--wait]
                                        print the link that account approves, in its browser
  status                                show the delegation
  robots                                list the robots it may see
  claim CODE [--label NAME] [--preview] add a robot with its pairing code
  label ROBOT_ID NAME                   set your name for a robot ("" clears it)
  unlink ROBOT_ID --yes                 unlink a robot
  read ROBOT_ID PATH                    read-only GET on the robot's app, e.g. /api/system/info
  revoke --yes                          end this delegation now
  mcp                                   serve the tools to an AI agent (Model Context Protocol, stdio)

Scopes: robots:read, robots:claim, robots:manage, sessions:readonly.
The profile directory is $MC_DELEGATE_HOME/<profile>, else ~/.config/mowgli-connect-delegate/<profile>.
`

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "mc-delegate:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, argv []string, stdin io.Reader, stdout, stderr io.Writer) error {
	global := flag.NewFlagSet("mc-delegate", flag.ContinueOnError)
	global.SetOutput(stderr)
	global.Usage = func() { fmt.Fprint(stderr, usage) }
	profile := global.String("profile", envOr("MC_DELEGATE_PROFILE", "default"), "profile name")
	if err := global.Parse(argv); err != nil {
		return err
	}
	args := global.Args()
	if len(args) == 0 {
		global.Usage()
		return errors.New("no command")
	}
	dir, err := client.ProfileDir(*profile)
	if err != nil {
		return err
	}
	cmd, rest := args[0], args[1:]
	if cmd == "init" {
		return cmdInit(dir, rest, stdout, stderr)
	}
	p, err := client.Load(dir)
	if err != nil {
		return err
	}
	c := client.New(p)
	switch cmd {
	case "request":
		return cmdRequest(ctx, p, c, rest, stdout, stderr)
	case "status":
		s, err := c.Self(ctx)
		if err != nil {
			return explain(err)
		}
		return printJSON(stdout, s)
	case "robots":
		r, err := c.Robots(ctx)
		if err != nil {
			return explain(err)
		}
		return printJSON(stdout, map[string]any{"robots": r})
	case "claim":
		return cmdClaim(ctx, c, rest, stdout)
	case "label":
		if len(rest) != 2 {
			return errors.New("usage: label ROBOT_ID NAME")
		}
		return explain(c.Label(ctx, rest[0], rest[1]))
	case "unlink":
		fs := flag.NewFlagSet("unlink", flag.ContinueOnError)
		yes := fs.Bool("yes", false, "really unlink")
		if err := parseInterleaved(fs, rest); err != nil {
			return err
		}
		if fs.NArg() != 1 || !*yes {
			return errors.New("usage: unlink ROBOT_ID --yes (the robot then needs a new pairing code on site)")
		}
		return explain(c.Unlink(ctx, fs.Arg(0)))
	case "read":
		if len(rest) != 2 {
			return errors.New("usage: read ROBOT_ID PATH")
		}
		r, err := c.ReadRobot(ctx, rest[0], rest[1])
		if err != nil {
			return explain(err)
		}
		fmt.Fprintf(stderr, "robot answered %d (%s)\n", r.Status, r.ContentType)
		_, err = stdout.Write(r.Body)
		return err
	case "revoke":
		if len(rest) != 1 || rest[0] != "--yes" {
			return errors.New("usage: revoke --yes")
		}
		if err := c.Revoke(ctx); err != nil {
			return explain(err)
		}
		fmt.Fprintln(stdout, "Revoked. This key can never be approved again; for new access, create a new key with --profile <new name> init.")
		return nil
	case "mcp":
		return (&mcp.Server{API: c, Version: version}).Serve(ctx, stdin, stdout)
	}
	global.Usage()
	return fmt.Errorf("unknown command %q", cmd)
}

func cmdInit(dir string, rest []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(stderr)
	relay := fs.String("relay", client.DefaultRelay, "relay origin")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	p, err := client.Create(dir, strings.TrimRight(*relay, "/"))
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Created a key in %s (mode 600; it never leaves this machine).\nFingerprint: %s\nNext: mc-delegate request --name \"...\" --scopes robots:read\n", p.Dir, client.Fingerprint(p.ID()))
	return nil
}

func cmdRequest(ctx context.Context, p *client.Profile, c *client.Client, rest []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("request", flag.ContinueOnError)
	fs.SetOutput(stderr)
	host, _ := os.Hostname()
	account := fs.String("account", p.Account, "your GitHub login: only this account can approve the link")
	name := fs.String("name", "AI agent on "+host, "name shown on the consent page")
	scopes := fs.String("scopes", "robots:read", "comma-separated scopes")
	ttl := fs.String("ttl", "24h", "how long: 1h, 8h, 24h, 7d or 30d")
	wait := fs.Bool("wait", false, "wait until it is approved (up to 10 minutes)")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	d, err := parseTTL(*ttl)
	if err != nil {
		return err
	}
	if err := client.CheckAccount(*account); err != nil {
		return err
	}
	// The link names the account's immutable id, which GitHub never hands on, unlike a login.
	uid, login, err := c.LookupAccount(ctx, *account)
	if err != nil {
		return err
	}
	if login != p.Account || uid != p.AccountID {
		if err := p.SaveAccount(login, uid); err != nil {
			return err
		}
	}
	list := strings.FieldsFunc(*scopes, func(r rune) bool { return r == ',' || r == ' ' })
	fmt.Fprintf(stdout, "Open this link in the browser where you are signed in to Mowgli Connect as @%s (%s), check that it shows the fingerprint\n\n  %s\n\nand approve (the link works for %d minutes):\n\n%s\n\n",
		login, uid, client.Fingerprint(p.ID()), int(client.RequestValidity/time.Minute), c.ConsentURL(login, uid, *name, list, d))
	if !*wait {
		return nil
	}
	fmt.Fprintln(stderr, "Waiting for approval...")
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		s, err := c.Self(ctx)
		if err == nil && s.UserID != uid {
			return fmt.Errorf("the key was approved by @%s (%s), not @%s (%s): revoke it under AI agents on that account's robots page and start over with a new --profile", s.Login, s.UserID, login, uid)
		}
		if err == nil && s.ExpiresAt > time.Now().Unix() {
			fmt.Fprintf(stdout, "Approved for @%s until %s: %s\n", s.Login, time.Unix(s.ExpiresAt, 0).UTC().Format(time.RFC3339), strings.Join(s.Scopes, " "))
			return nil
		}
		var ae *client.APIError
		if err != nil && !(errors.As(err, &ae) && (ae.Detail == "unknown_delegate" || ae.Code == "delegation_expired" || ae.Code == "delegation_revoked")) {
			return explain(err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return errors.New("not approved within 10 minutes; run request again")
}

func cmdClaim(ctx context.Context, c *client.Client, rest []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("claim", flag.ContinueOnError)
	label := fs.String("label", "", "name for the robot (also its address)")
	preview := fs.Bool("preview", false, "only show which robot and address it would be")
	if err := parseInterleaved(fs, rest); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: claim CODE [--label NAME] [--preview]")
	}
	r, err := c.Claim(ctx, fs.Arg(0), *label, false)
	if err != nil {
		return explain(err)
	}
	if *preview {
		return printJSON(stdout, r)
	}
	if r, err = c.Claim(ctx, fs.Arg(0), *label, true); err != nil {
		return explain(err)
	}
	return printJSON(stdout, r)
}

// parseInterleaved accepts flags before and after positional arguments.
func parseInterleaved(fs *flag.FlagSet, args []string) error {
	var pos []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return err
		}
		args = fs.Args()
		if len(args) > 0 {
			pos, args = append(pos, args[0]), args[1:]
		}
	}
	return fs.Parse(append([]string{"--"}, pos...))
}

func parseTTL(s string) (time.Duration, error) {
	if n, ok := strings.CutSuffix(s, "d"); ok {
		days, err := strconv.Atoi(n)
		if err == nil && days > 0 && days <= 30 {
			return time.Duration(days) * 24 * time.Hour, nil
		}
	} else if d, err := time.ParseDuration(s); err == nil && d >= time.Hour && d <= 30*24*time.Hour {
		return d, nil
	}
	return 0, fmt.Errorf("--ttl must be between 1h and 30d, like 8h or 7d")
}

func explain(err error) error {
	var ae *client.APIError
	if errors.As(err, &ae) {
		switch {
		case ae.Detail == "unknown_delegate":
			return fmt.Errorf("%w; this key has no delegation yet: run mc-delegate request", err)
		case ae.Code == "delegation_expired":
			return fmt.Errorf("%w; renew it under AI agents on the robots page, or run mc-delegate request", err)
		case ae.Code == "delegation_revoked":
			return fmt.Errorf("%w; a revoked key can never be approved again: create a new one with mc-delegate --profile <new name> init", err)
		}
	}
	return err
}

func printJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
