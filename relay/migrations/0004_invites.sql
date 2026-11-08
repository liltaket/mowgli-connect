-- Invitations managed from the admin page, and relay-wide settings.
-- Access is by GitHub numeric id ("gh:<id>"); the login is kept only for display.
CREATE TABLE invites (
  user_id     TEXT PRIMARY KEY CHECK (user_id GLOB 'gh:[1-9]*' AND length(user_id) <= 23),
  login       TEXT NOT NULL,                 -- GitHub login when invited (display only)
  name        TEXT,                          -- GitHub display name when invited
  robot_limit INTEGER CHECK (robot_limit IS NULL OR (robot_limit BETWEEN 0 AND 100)), -- NULL = default
  invited_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
