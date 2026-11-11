# mc-delegate

A small CLI and MCP server that lets an AI agent (Claude Code, Claude in T3 Code) or an automation
(the Mowgli Simulation Farm) act for you on Mowgli Connect, within a delegation you approve in the
browser: limited scopes and robots, an expiry, instant revocation and an activity log. It can never
drive a robot. Design, threat model and setup: [docs/agent-delegation.md](../docs/agent-delegation.md).

```sh
go build -o ~/.local/bin/mc-delegate ./cmd/mc-delegate
mc-delegate init
mc-delegate request --account <your GitHub login> --name "Claude (T3, laptop)" --scopes robots:read,sessions:readonly --ttl 24h --wait
claude mcp add --scope user mowgli-connect -- ~/.local/bin/mc-delegate mcp
```

`request` looks up the login's immutable account id on GitHub and signs that into the link, so
only that account can approve it. The key is kept in `~/.config/mowgli-connect-delegate/<profile>/key` (mode 600, never printed).
Standard library only; `go test ./...` runs the tests.
