import { describe, expect, it } from "vitest";
import { CloudflareTunnelProvisioner, createProvisioner, FakeProvisioner, robotHostname } from "../src/provisioner";
import { testEnv } from "./helpers";

interface Seen {
  method: string;
  path: string;
  body: any;
  auth: string | null;
}

/** Minimal in-memory Cloudflare double so we can check call order, shapes and idempotency. */
function cfDouble(opts: { tunnels?: any[]; dns?: any[]; failDeleteTunnel?: boolean } = {}) {
  const seen: Seen[] = [];
  const tunnels = [...(opts.tunnels ?? [])];
  const dns = [...(opts.dns ?? [])];
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const fetchFn = (async (input: string, init: RequestInit) => {
    const u = new URL(input);
    const path = u.pathname.replace("/client/v4", "");
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    const method = init.method ?? "GET";
    seen.push({ method, path: path + u.search, body, auth: new Headers(init.headers).get("Authorization") });
    if (method === "GET" && path === "/accounts/ACCT/cfd_tunnel") {
      return ok(tunnels.filter((t) => !t.deleted_at)); // returns all, like a loose substring filter would
    }
    if (method === "POST" && path === "/accounts/ACCT/cfd_tunnel") {
      const t = { id: "tun-1", name: body.name, deleted_at: null };
      tunnels.push(t);
      return ok(t);
    }
    if (method === "PUT" && /\/configurations$/.test(path)) return ok({});
    if (method === "GET" && /\/token$/.test(path)) return ok("TOKEN-VALUE");
    if (method === "GET" && path === "/zones/ZONE/dns_records") return ok(dns);
    if (method === "POST" && path === "/zones/ZONE/dns_records") {
      const r = { id: "dns-1", ...body };
      dns.push(r);
      return ok(r);
    }
    if (method === "PATCH" && path.startsWith("/zones/ZONE/dns_records/")) return ok({});
    if (method === "DELETE" && path.endsWith("/connections")) return ok({});
    if (method === "DELETE" && path.startsWith("/zones/ZONE/dns_records/")) return ok({ id: "x" });
    if (method === "DELETE" && path.startsWith("/accounts/ACCT/cfd_tunnel/")) {
      if (opts.failDeleteTunnel) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1022, message: "active connections" }], result: null }), { status: 400 });
      }
      return ok({});
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

const cfg = (fetchFn: typeof fetch) => ({
  apiToken: "SECRET-API-TOKEN",
  accountId: "ACCT",
  zoneId: "ZONE",
  robotZone: "Robots.Example.COM",
  agentOrigin: "http://127.0.0.1:4007",
  fetchFn,
});

describe("CloudflareTunnelProvisioner", () => {
  it("creates tunnel, ingress config, proxied CNAME and fetches the token", async () => {
    const { seen, fetchFn } = cfDouble();
    const p = new CloudflareTunnelProvisioner(cfg(fetchFn));
    const r = await p.provision("abcdefghijklmnop");
    expect(r).toEqual({ hostname: "abcdefghijklmnop.robots.example.com", tunnelId: "tun-1", dnsRecordId: "dns-1", token: "TOKEN-VALUE" });

    const create = seen.find((s) => s.method === "POST" && s.path === "/accounts/ACCT/cfd_tunnel")!;
    expect(create.body).toEqual({ name: "mc-abcdefghijklmnop", config_src: "cloudflare" });
    const cfgCall = seen.find((s) => s.method === "PUT")!;
    expect(cfgCall.path).toBe("/accounts/ACCT/cfd_tunnel/tun-1/configurations");
    expect(cfgCall.body).toEqual({
      config: { ingress: [{ hostname: "abcdefghijklmnop.robots.example.com", service: "http://127.0.0.1:4007" }, { service: "http_status:404" }] },
    });
    const dns = seen.find((s) => s.method === "POST" && s.path === "/zones/ZONE/dns_records")!;
    expect(dns.body).toEqual({ type: "CNAME", name: "abcdefghijklmnop.robots.example.com", content: "tun-1.cfargotunnel.com", proxied: true, ttl: 1 });
    expect(seen.every((s) => s.auth === "Bearer SECRET-API-TOKEN")).toBe(true);
  });

  it("is idempotent: reuses a tunnel with the same name (exact match only) and existing DNS", async () => {
    const { seen, fetchFn } = cfDouble({
      tunnels: [
        { id: "other", name: "mc-abcdefghijklmnopX", deleted_at: null },
        { id: "tun-9", name: "mc-abcdefghijklmnop", deleted_at: null },
      ],
      dns: [{ id: "dns-9", type: "CNAME", name: "abcdefghijklmnop.robots.example.com", content: "tun-9.cfargotunnel.com", proxied: true }],
    });
    const r = await new CloudflareTunnelProvisioner(cfg(fetchFn)).provision("abcdefghijklmnop");
    expect(r.tunnelId).toBe("tun-9");
    expect(r.dnsRecordId).toBe("dns-9");
    expect(seen.some((s) => s.method === "POST")).toBe(false);
    expect(seen.some((s) => s.method === "PATCH")).toBe(false);
    expect(seen.find((s) => s.path.startsWith("/zones/ZONE/dns_records"))!.path).toContain("name.exact=abcdefghijklmnop.robots.example.com");
  });

  it("repairs a DNS record that points elsewhere", async () => {
    const { seen, fetchFn } = cfDouble({
      dns: [{ id: "dns-9", type: "CNAME", name: "abcdefghijklmnop.robots.example.com", content: "stale.cfargotunnel.com", proxied: false }],
    });
    await new CloudflareTunnelProvisioner(cfg(fetchFn)).provision("abcdefghijklmnop");
    const patch = seen.find((s) => s.method === "PATCH")!;
    expect(patch.path).toBe("/zones/ZONE/dns_records/dns-9");
    expect(patch.body.content).toBe("tun-1.cfargotunnel.com");
    expect(patch.body.proxied).toBe(true);
  });

  it("deprovision removes DNS then clears connections and deletes the tunnel", async () => {
    const { seen, fetchFn } = cfDouble();
    await new CloudflareTunnelProvisioner(cfg(fetchFn)).deprovision({
      robotId: "abcdefghijklmnop",
      hostname: "abcdefghijklmnop.robots.example.com",
      tunnelId: "tun-1",
      dnsRecordId: "dns-1",
    });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "DELETE /zones/ZONE/dns_records/dns-1",
      "DELETE /accounts/ACCT/cfd_tunnel/tun-1/connections",
      "DELETE /accounts/ACCT/cfd_tunnel/tun-1",
    ]);
  });

  it("errors never leak the API token", async () => {
    const { fetchFn } = cfDouble({ failDeleteTunnel: true });
    const err = await new CloudflareTunnelProvisioner(cfg(fetchFn))
      .deprovision({ robotId: "abcdefghijklmnop", hostname: null, tunnelId: "tun-1", dnsRecordId: "d" })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("1022");
    expect((err as Error).message).not.toContain("SECRET-API-TOKEN");
  });
});

describe("provisioner selection", () => {
  it("FakeProvisioner is deterministic", async () => {
    const f = new FakeProvisioner("robots.test");
    expect(await f.provision("abcdefghijklmnop")).toEqual(await f.provision("abcdefghijklmnop"));
    expect(robotHostname("abcdefghijklmnop", "robots.test")).toBe("abcdefghijklmnop.robots.test");
  });

  it("PROVISIONER=fake only when explicitly set; default needs Cloudflare config", () => {
    expect(createProvisioner(testEnv)).toBeInstanceOf(FakeProvisioner);
    expect(() => createProvisioner({ ...testEnv, PROVISIONER: undefined })).toThrow(/CF_API_TOKEN/);
    expect(() => createProvisioner({ ...testEnv, PROVISIONER: "bogus" })).toThrow(/unknown PROVISIONER/);
    expect(
      createProvisioner({ ...testEnv, PROVISIONER: "cloudflare", CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a", CF_ZONE_ID: "z" }),
    ).toBeInstanceOf(CloudflareTunnelProvisioner);
  });
});
