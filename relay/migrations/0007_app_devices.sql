-- Native app devices (docs/app-api.md): a Secure Enclave P-256 public key per phone. Nothing
-- here is a secret; the private key never leaves the phone.
CREATE TABLE devices (
  device_id    TEXT PRIMARY KEY,                  -- RFC 7638 thumbprint of the key
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                     -- shown to the person ("Bruno's iPhone")
  public_jwk   TEXT NOT NULL,                     -- {"kty":"EC","crv":"P-256","x","y"}
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX devices_user_idx ON devices(user_id);

-- One-time sign-in codes: 60 seconds, single use, stored as a hash, bound to the person, the
-- PKCE challenge and the device key's thumbprint.
CREATE TABLE app_codes (
  code_hash      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  key_thumbprint TEXT NOT NULL,
  device_name    TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
) WITHOUT ROWID;
