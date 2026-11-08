import type { Env } from "./env";

export interface ProvisionedTunnel {
  /** null in quick-tunnel mode: the robot reports the hostname cloudflared assigned it. */
  hostname: string | null;
  tunnelId: string | null;
  dnsRecordId: string | null;
  /** SENSITIVE cloudflared connector token. null in quick-tunnel mode. */
  token: string | null;
}

export interface TunnelRef {
  robotId: string;
  hostname: string | null;
  tunnelId: string | null;
  dnsRecordId: string | null;
}

/**
 * Hostnames are one label under the robot zone: either the robot id or a name the relay chose
 * and reserved with robotSubdomain(). No caller-supplied hostname or origin is ever accepted.
 */
export interface TunnelProvisioner {
  /** Whether this provisioner creates `<label>.<zone>` hostnames (so the relay picks a label). */
  readonly assignsHostnames: boolean;
  /** Idempotent: safe to call again for the same robot. `label` must come from robotSubdomain(). */
  provision(robotId: string, label?: string): Promise<ProvisionedTunnel>;
  /** Idempotent: missing resources count as success. */
  deprovision(ref: TunnelRef): Promise<void>;
}

export function robotHostname(label: string, zone: string): string {
  return `${label}.${zone.replace(/^\.+|\.+$/g, "").toLowerCase()}`;
}

// Names that could be mistaken for a service of the zone itself.
const RESERVED_LABELS = new Set(
  ("www api app auth login logout signin account accounts admin connect relay mail smtp imap pop mx ns ns1 ns2 " +
    "ftp cdn static assets dash dashboard status support help docs blog shop git dev test staging robots robot")
    .split(" "),
);

/**
 * A readable hostname label from the owner's label or the robot's name ("Front lawn" ->
 * "front-lawn"), or null when none is usable. It can never look like a robot id, so it cannot
 * collide with the fallback `<robotId>.<zone>` names.
 */
export function robotSubdomain(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  if (s.length < 3 || RESERVED_LABELS.has(s) || /^[a-z2-7]{16}$/.test(s) || s.startsWith("xn--")) return null;
  return s;
}

function checkedLabel(robotId: string, label?: string): string {
  if (label === undefined) return robotId;
  if (robotSubdomain(label) !== label) throw new Error("invalid hostname label");
  return label;
}

/** Deterministic, no network. For tests / local dev only (PROVISIONER=fake). */
export class FakeProvisioner implements TunnelProvisioner {
  readonly assignsHostnames = true;
  readonly provisioned: string[] = [];
  readonly deprovisioned: string[] = [];
  constructor(private readonly zone = "robots.invalid") {}

  async provision(robotId: string, label?: string): Promise<ProvisionedTunnel> {
    this.provisioned.push(robotId);
    return {
      hostname: robotHostname(checkedLabel(robotId, label), this.zone),
      tunnelId: `fake-tunnel-${robotId}`,
      dnsRecordId: `fake-dns-${robotId}`,
      token: `fake-tunnel-token-${robotId}`,
    };
  }

  async deprovision(ref: TunnelRef): Promise<void> {
    this.deprovisioned.push(ref.robotId);
  }
}

/**
 * Quick-tunnel mode (PROVISIONER=quick): the robot runs a Cloudflare Quick Tunnel and reports its
 * `*.trycloudflare.com` hostname itself (POST /v1/robots/hostname). Nothing is created or deleted
 * on Cloudflare, so there is no CF_API_TOKEN, zone or tunnel token.
 */
export class QuickProvisioner implements TunnelProvisioner {
  readonly assignsHostnames = false;
  async provision(_robotId: string): Promise<ProvisionedTunnel> {
    return { hostname: null, tunnelId: null, dnsRecordId: null, token: null };
  }

  async deprovision(_ref: TunnelRef): Promise<void> {}
}

/** The hostname already has DNS records that are not a robot tunnel; nothing was changed. */
export class HostnameInUseError extends Error {}

export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  zoneId: string;
  robotZone: string;
  agentOrigin: string;
  fetchFn?: typeof fetch;
}

const API = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

interface CfTunnel {
  id: string;
  name: string;
  deleted_at?: string | null;
}

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

export class CloudflareTunnelProvisioner implements TunnelProvisioner {
  readonly assignsHostnames = true;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly cfg: CloudflareConfig) {
    this.fetchFn = cfg.fetchFn ?? ((...a) => fetch(...a));
  }

  private async call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T | null> {
    const res = await this.fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (okStatuses.includes(res.status)) return null;
    let env: CfEnvelope<T> | null = null;
    try {
      env = (await res.json()) as CfEnvelope<T>;
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok || !env?.success) {
      // Never include request headers/bodies (token) in the error.
      const detail = env?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? "no error detail";
      throw new CloudflareApiError(res.status, `Cloudflare API ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return env.result;
  }

  private tunnelName(robotId: string): string {
    return `mc-${robotId}`;
  }

  private async findTunnel(robotId: string): Promise<CfTunnel | null> {
    const name = this.tunnelName(robotId);
    const list = await this.call<CfTunnel[]>(
      "GET",
      `/accounts/${this.cfg.accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    );
    // The `name` filter semantics (exact vs substring) are undocumented: match exactly ourselves.
    return list?.find((t) => t.name === name && !t.deleted_at) ?? null;
  }

  /**
   * The CNAME for a robot hostname, or null. Throws HostnameInUseError if the name has any record
   * that is not a proxied CNAME to a tunnel: the zone may hold other services (a website, mail),
   * and those must never be overwritten or later deleted.
   */
  private async findDns(hostname: string): Promise<CfDnsRecord | null> {
    const list =
      (await this.call<CfDnsRecord[]>("GET", `/zones/${this.cfg.zoneId}/dns_records?name.exact=${encodeURIComponent(hostname)}`)) ??
      [];
    const mine = list.filter((r) => r.name.toLowerCase() === hostname);
    if (mine.some((r) => r.type !== "CNAME" || !r.content.toLowerCase().endsWith(".cfargotunnel.com"))) {
      throw new HostnameInUseError(`${hostname} already has other DNS records`);
    }
    return mine[0] ?? null;
  }

  async provision(robotId: string, label?: string): Promise<ProvisionedTunnel> {
    const acct = this.cfg.accountId;
    const hostname = robotHostname(checkedLabel(robotId, label), this.cfg.robotZone);

    let tunnel = await this.findTunnel(robotId);
    if (!tunnel) {
      tunnel = await this.call<CfTunnel>("POST", `/accounts/${acct}/cfd_tunnel`, {
        name: this.tunnelName(robotId),
        config_src: "cloudflare",
      });
    }
    if (!tunnel?.id) throw new CloudflareApiError(502, "Cloudflare did not return a tunnel id");

    await this.call("PUT", `/accounts/${acct}/cfd_tunnel/${tunnel.id}/configurations`, {
      config: {
        ingress: [{ hostname, service: this.cfg.agentOrigin }, { service: "http_status:404" }],
      },
    });

    const content = `${tunnel.id}.cfargotunnel.com`;
    const dnsBody = { type: "CNAME", name: hostname, content, proxied: true, ttl: 1 };
    const existing = await this.findDns(hostname);
    let dnsRecordId: string;
    if (!existing) {
      const rec = await this.call<CfDnsRecord>("POST", `/zones/${this.cfg.zoneId}/dns_records`, dnsBody);
      if (!rec?.id) throw new CloudflareApiError(502, "Cloudflare did not return a DNS record id");
      dnsRecordId = rec.id;
    } else {
      if (existing.content !== content || existing.proxied !== true) {
        await this.call("PATCH", `/zones/${this.cfg.zoneId}/dns_records/${existing.id}`, dnsBody);
      }
      dnsRecordId = existing.id;
    }

    const token = await this.call<string>("GET", `/accounts/${acct}/cfd_tunnel/${tunnel.id}/token`);
    if (typeof token !== "string" || !token) throw new CloudflareApiError(502, "Cloudflare did not return a tunnel token");
    return { hostname, tunnelId: tunnel.id, dnsRecordId, token };
  }

  async deprovision(ref: TunnelRef): Promise<void> {
    const acct = this.cfg.accountId;
    const hostname = ref.hostname ?? robotHostname(ref.robotId, this.cfg.robotZone);

    // DNS first so the name stops resolving to the tunnel.
    let dnsId = ref.dnsRecordId;
    if (!dnsId) {
      try {
        dnsId = (await this.findDns(hostname))?.id ?? null;
      } catch (e) {
        if (!(e instanceof HostnameInUseError)) throw e; // not ours: leave it alone
      }
    }
    if (dnsId) await this.call("DELETE", `/zones/${this.cfg.zoneId}/dns_records/${dnsId}`, undefined, [404]);

    let tunnelId = ref.tunnelId;
    if (!tunnelId) tunnelId = (await this.findTunnel(ref.robotId))?.id ?? null;
    if (tunnelId) {
      // A tunnel with active connections cannot be deleted; drop stale connections first (best effort).
      try {
        await this.call("DELETE", `/accounts/${acct}/cfd_tunnel/${tunnelId}/connections`, undefined, [404]);
      } catch {
        /* the delete below reports the real failure */
      }
      await this.call("DELETE", `/accounts/${acct}/cfd_tunnel/${tunnelId}`, undefined, [404]);
    }
  }
}

export function createProvisioner(env: Env): TunnelProvisioner {
  if (env.PROVISIONER === "quick") return new QuickProvisioner();
  if ((env.PROVISIONER ?? "cloudflare") === "fake") return new FakeProvisioner(env.ROBOT_ZONE || undefined);
  if (env.PROVISIONER && env.PROVISIONER !== "cloudflare") throw new Error(`unknown PROVISIONER "${env.PROVISIONER}"`);
  const { CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, ROBOT_ZONE } = env;
  if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !CF_ZONE_ID || !ROBOT_ZONE) {
    throw new Error("Cloudflare provisioner requires CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID, ROBOT_ZONE");
  }
  return new CloudflareTunnelProvisioner({
    apiToken: CF_API_TOKEN,
    accountId: CF_ACCOUNT_ID,
    zoneId: CF_ZONE_ID,
    robotZone: ROBOT_ZONE,
    agentOrigin: env.AGENT_ORIGIN || "http://127.0.0.1:4007",
  });
}
