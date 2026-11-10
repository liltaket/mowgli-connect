-- Delegations to AI agents and automations (docs/agent-delegation.md). Numbered 0010 so that
-- 0009 stays free for the simulator flag (feat/simulator-robots). Nothing here is a secret: the
-- private keys never leave the agent's machine.
CREATE TABLE delegations (
  delegation_id TEXT PRIMARY KEY CHECK (length(delegation_id) = 16), -- derived from the key, like a robot id
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- the person who approved it
  public_key    TEXT NOT NULL UNIQUE,                                 -- raw Ed25519 key, base64url
  name          TEXT NOT NULL,                                        -- chosen by the agent, shown to the person
  scopes        TEXT NOT NULL,                                        -- space-separated, canonical order
  ttl_seconds   INTEGER NOT NULL,                                     -- the approved duration (renewal repeats it)
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_used_at  INTEGER
);
CREATE INDEX delegations_user_idx ON delegations(user_id);

-- The robots a delegation may touch: ticked on the consent page, or added by the delegate itself.
CREATE TABLE delegation_robots (
  delegation_id TEXT NOT NULL REFERENCES delegations(delegation_id) ON DELETE CASCADE,
  robot_id      TEXT NOT NULL,
  via           TEXT NOT NULL CHECK (via IN ('consent', 'claim')),
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (delegation_id, robot_id)
) WITHOUT ROWID;
CREATE INDEX delegation_robots_robot_idx ON delegation_robots(robot_id);

-- Activity log, shown to the person. The agent's own entries also count towards its rate limit.
CREATE TABLE delegation_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  delegation_id TEXT NOT NULL,
  at            INTEGER NOT NULL,
  actor         TEXT NOT NULL CHECK (actor IN ('agent', 'person', 'app', 'admin')),
  action        TEXT NOT NULL,
  robot_id      TEXT,
  outcome       TEXT NOT NULL,
  detail        TEXT
);
CREATE INDEX delegation_events_idx ON delegation_events(delegation_id, at);
