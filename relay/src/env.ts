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
  MAX_NEW_ROBOTS_PER_HOUR?: string; // global cap on new unclaimed robots (default 30)

  // Secrets
  RELAY_SIGNING_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  CF_API_TOKEN?: string;
}

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {}
  }
}

export type Env = RelayEnv;
