-- Mowgli Connect relay schema (v0 prototype).
-- All timestamps are integer Unix seconds.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- "gh:<numeric github id>"
  login         TEXT NOT NULL,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- Browser sessions. Only the SHA-256 (hex) of the cookie token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- In-flight GitHub OAuth logins (state + PKCE verifier). Keyed by SHA-256 of state.
CREATE TABLE oauth_states (
  state_hash    TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  return_to     TEXT NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX oauth_states_expires_idx ON oauth_states(expires_at);

CREATE TABLE robots (
  robot_id      TEXT PRIMARY KEY CHECK (length(robot_id) = 16),
  public_key    TEXT NOT NULL UNIQUE,        -- raw Ed25519 key, base64url
  name          TEXT,                        -- robot-reported, untrusted display text
  status        TEXT NOT NULL CHECK (status IN ('unclaimed', 'claimed', 'revoked')),
  session_epoch INTEGER NOT NULL DEFAULT 1,
  hostname      TEXT UNIQUE,
  tunnel_id     TEXT,
  dns_record_id TEXT,
  -- SENSITIVE: cloudflared connector token. Whoever holds it can run this tunnel.
  tunnel_token  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE members (
  robot_id   TEXT NOT NULL REFERENCES robots(robot_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
  label      TEXT,                           -- per-user display label
  created_at INTEGER NOT NULL,
  PRIMARY KEY (robot_id, user_id)
);
CREATE INDEX members_user_idx ON members(user_id);

-- Pairing codes. Only the SHA-256 (hex) of the normalized code is stored.
CREATE TABLE pairing_codes (
  code_hash  TEXT PRIMARY KEY,
  robot_id   TEXT NOT NULL REFERENCES robots(robot_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX pairing_codes_robot_idx ON pairing_codes(robot_id);
CREATE INDEX pairing_codes_expires_idx ON pairing_codes(expires_at);

CREATE TABLE claim_failures (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX claim_failures_user_idx ON claim_failures(user_id, at);

-- Robot assertion replay protection (single-use jti, kept until exp + skew).
CREATE TABLE jti_seen (
  robot_id   TEXT NOT NULL,
  jti        TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (robot_id, jti)
);
CREATE INDEX jti_seen_expires_idx ON jti_seen(expires_at);
