# Emergency stop

One switch that ends all remote access at once. Use it when you suspect a stolen account, a relay
bug or a bad update, then look into it calmly.

## What it does

While it is on:

- Nobody gets a new session or grant: `/open/<robot>` answers 503, the app API answers 503
  `{"error":"paused"}` (signing out still works), and a GitHub sign-in by anyone but an admin is
  refused. Admins can sign in, to turn it off again.
- Every robot's `GET /v1/robots/self` answers `tunnelToken: null`, `members: []` and
  `"paused": true`. The agent stops its tunnel (named tunnels) and accepts nobody, at its next
  sync: within `MC_POLL_INTERVAL` (3 minutes). A robot that cannot reach the relay stops accepting
  anything after `MC_MAX_STALE` (10 minutes) by itself.
- Turning it on also ends what exists: every robot's session epoch goes up, so sessions and grants
  from before stay dead after it is turned off, and every non-admin browser session is deleted.
  App devices stay paired but get nothing until it is off.
- An alert goes to `ALERT_NTFY_URL` if it is set.

It does not touch the robot's own firmware, its emergency stop button or anything running on the
robot itself. It also does not pause the nightly image update: the robot's cron job runs
`docker compose pull` on the host and the relay cannot reach it. If you suspect the image itself,
stop updates on the robots by hand (`crontab -e`, or reinstall with `--auto-update no`).

## Turning it on and off

**From the admin page** (`/admin`): "Emergency stop" at the top, tick the box, press the button.
While it is on, the same place shows a button that turns it off.

**Without signing in to the relay**, for when the admin's own sign-in is what you doubt. The state is
one row in the `settings` table, so use the Cloudflare API token that owns the relay's D1 database:

```sh
cd relay
npx wrangler d1 execute mowgli-connect-relay --remote -c wrangler.prod.jsonc --command "
INSERT INTO settings (key, value) VALUES ('kill_switch', strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value;
UPDATE robots SET session_epoch = session_epoch + 1 WHERE status = 'claimed';
DELETE FROM sessions;"
```

and to turn it off:

```sh
npx wrangler d1 execute mowgli-connect-relay --remote -c wrangler.prod.jsonc --command "DELETE FROM settings WHERE key = 'kill_switch';"
```

The last statement of the first command also signs the admin out, which is the safe default there.
Rotating the GitHub OAuth client secret (`wrangler secret put GITHUB_CLIENT_SECRET`) is the other
lever when the GitHub side is the worry: nobody can sign in until it matches again.
