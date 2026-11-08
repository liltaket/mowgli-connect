export interface RelayEnv {
  DB: D1Database;

  // Plain vars
  RELAY_ORIGIN: string;
  RELAY_KEY_ID: string;
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
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  CF_API_TOKEN?: string;
  AGENT_IMAGE_REPO?: string; // owner/repo whose agent-image builds define the latest agent (default liltaket/mowgli-connect)
  ALERT_NTFY_URL?: string; // operator alerts, e.g. https://ntfy.sh/<topic>
  APP_IOS_APP_IDS?: string; // <TeamID>.<bundle id>, comma list: enables the native app API (docs/app-api.md)
  TUNNEL_TOKEN_KEY?: string; // 32 bytes base64url: encrypts tunnel tokens at rest
}

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}

export type Env = RelayEnv;
