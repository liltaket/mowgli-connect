export interface RelayEnv {
  DB: D1Database;

  // Plain vars
  RELAY_ORIGIN: string;
  RELAY_KEY_ID: string;
  RELAY_PREVIOUS_KEY_ID?: string; // kid of RELAY_PREVIOUS_SIGNING_KEY, during a key rotation
  // Comma list of origins the relay used to have (a domain move): robots that still call one are
  // served and told the new RELAY_ORIGIN in a signed answer; browsers are redirected there.
  RELAY_LEGACY_ORIGINS?: string;
  PROVISIONER?: string; // "cloudflare" (default) | "quick" | "fake"
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  ROBOT_ZONE?: string;
  AGENT_ORIGIN?: string;
  ALLOWED_GITHUB_LOGINS?: string;
  ADMIN_GITHUB_IDS?: string; // comma list of gh:<id>: who may open /admin
  MAX_NEW_ROBOTS_PER_HOUR?: string; // global cap on new unclaimed robots (default 30)

  // Secrets
  RELAY_SIGNING_KEY: string;
  RELAY_PREVIOUS_SIGNING_KEY?: string; // the replaced key during a rotation (docs/protocol.md)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  CF_API_TOKEN?: string;
  AGENT_IMAGE_REPO?: string; // owner/repo whose agent-image builds define the latest agent (default liltaket/mowgli-connect)
  ALERT_NTFY_URL?: string; // operator alerts, e.g. https://ntfy.sh/<topic>
  APP_IOS_APP_IDS?: string; // <TeamID>.<bundle id>, comma list: enables the native app API (docs/app-api.md)
  APP_REDIRECT_URIS?: string; // optional private-use scheme callbacks, <bundle id>:/<path> (free Apple teams)
  TUNNEL_TOKEN_KEY?: string; // 32 bytes base64url: encrypts tunnel tokens at rest
  DELEGATION_USERS?: string; // comma list of gh:<id> (or "*") who may delegate to AI agents (docs/agent-delegation.md); empty = off
}

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}

export type Env = RelayEnv;
