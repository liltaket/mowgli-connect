-- Sharing a robot (docs/protocol.md, "Sharing"): a third role, 'operator' ("Can control"), next
-- to 'owner' and 'viewer' ("View only"). SQLite cannot change a CHECK constraint, so members is
-- rebuilt, keeping every row. No table references members, so dropping and renaming it leaves
-- the others intact (migrations/0005 rebuilt jti_seen the same way).
CREATE TABLE members_new (
  robot_id   TEXT NOT NULL REFERENCES robots(robot_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  label      TEXT,                           -- per-user display label
  created_at INTEGER NOT NULL,
  PRIMARY KEY (robot_id, user_id)
);
INSERT INTO members_new (robot_id, user_id, role, label, created_at)
  SELECT robot_id, user_id, role, label, created_at FROM members;
DROP TABLE members;
ALTER TABLE members_new RENAME TO members;
CREATE INDEX members_user_idx ON members(user_id);
-- A robot has one owner. The code never adds a second one; the database makes sure of it.
CREATE UNIQUE INDEX members_one_owner_idx ON members(robot_id) WHERE role = 'owner';

-- Hourly budgets for sharing: GitHub account lookups (per person and for the whole relay, so the
-- share form is no way to enumerate GitHub or use up the relay's GitHub rate limit) and new
-- shares per owner. Rows live an hour; the cron deletes older ones, so the table stays small.
CREATE TABLE share_events (
  id      INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('lookup', 'share')),
  at      INTEGER NOT NULL
);
CREATE INDEX share_events_user_idx ON share_events(user_id, kind, at);
