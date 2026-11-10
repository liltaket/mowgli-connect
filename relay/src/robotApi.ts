import { canOwn } from "./access";
import { alert } from "./alerts";
import type { Env } from "./env";
import { openToken } from "./tokenSeal";
import { AssertionError, verifyRobotAssertion, type VerifiedAssertion } from "./assertion";
import { b64urlDecode, deriveRobotId } from "./crypto";
import { loadRelayKey } from "./relayKey";
import { formatPairingCode, generatePairingCode, hashPairingCode, PAIRING_TTL_SECONDS } from "./pairing";
import { SECURITY_HEADERS } from "./html";
import { cleanLabel, nowSeconds, readBodyText, sha256Hex, SKEW_SECONDS } from "./util";

export function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...extra },
  });
}

interface RobotRow {
  robot_id: string;
  public_key: string;
  name: string | null;
  status: "unclaimed" | "claimed" | "revoked";
  session_epoch: number;
  hostname: string | null;
  tunnel_id: string | null;
  tunnel_token: string | null;
  last_seen_at: number;
  agent_version: string | null;
  allow_teleop: number | null;
}

function verifyAssertion(
  env: Env,
  request: Request,
  url: URL,
  resolveKey: (iss: string) => Promise<Uint8Array | null>,
): Promise<VerifiedAssertion> {
  return verifyRobotAssertion({
    authorization: request.headers.get("Authorization"),
    method: request.method,
    htu: `${env.RELAY_ORIGIN}${url.pathname}`,
    aud: env.RELAY_ORIGIN,
    now: nowSeconds(),
    resolveKey,
  });
}

// Single use. Stored until exp + skew so a replay inside the accepted window is still rejected.
async function consumeJti(env: Env, a: VerifiedAssertion): Promise<void> {
  const res = await env.DB.prepare("INSERT OR IGNORE INTO jti_seen (robot_id, jti, expires_at) VALUES (?, ?, ?)")
    .bind(a.robotId, a.jti, a.exp + SKEW_SECONDS)
    .run();
  if (res.meta.changes !== 1) throw new AssertionError("replayed_jti");
}

async function authenticate(
  env: Env,
  request: Request,
  url: URL,
  resolveKey: (iss: string) => Promise<Uint8Array | null>,
): Promise<VerifiedAssertion> {
  const a = await verifyAssertion(env, request, url, resolveKey);
  await consumeJti(env, a);
  return a;
}

function assertionFailure(e: AssertionError, unknownStatus = 401): Response {
  const status = e.code === "unknown_robot" ? unknownStatus : 401;
  return json({ error: e.code === "unknown_robot" && status === 404 ? "unknown_robot" : "invalid_assertion", detail: e.code }, status, {
    "WWW-Authenticate": 'MC-Robot error="invalid_token"',
  });
}

async function readJson(request: Request, max = 4096): Promise<Record<string, unknown> | null> {
  const text = await readBodyText(request, max);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// A robot asks for a new pairing code when its code is about to expire (15 min) or on restart.
const REREGISTER_MIN_SECONDS = 30;

async function recentUnclaimed(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM robots WHERE status = 'unclaimed' AND created_at > ?")
    .bind(now - 3600)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** New unclaimed robots one network may register per hour, so it cannot use up the global cap. */
export const NEW_ROBOTS_PER_NETWORK_PER_HOUR = 5;

/**
 * A coarse, hashed key for the client's network (IPv4 /24, IPv6 /48), from Cloudflare's
 * CF-Connecting-IP. null without that header (local tests); the raw address is never stored.
 */
export async function networkKey(request: Request): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return null;
  let net: string;
  if (ip.includes(":")) {
    const groups = ip.split(":");
    net = groups.slice(0, 3).join(":") + "::/48";
  } else {
    net = ip.split(".").slice(0, 3).join(".") + ".0/24";
  }
  return (await sha256Hex(`mc-net:${net}`)).slice(0, 24);
}

function maxNewRobotsPerHour(env: Env): number {
  const n = Number.parseInt(env.MAX_NEW_ROBOTS_PER_HOUR ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export async function registerRobot(env: Env, request: Request, url: URL): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json({ error: "bad_request" }, 400);
  const { publicKey, name } = body;
  if (typeof publicKey !== "string") return json({ error: "bad_request", detail: "publicKey" }, 400);
  if (name !== undefined && (typeof name !== "string" || name.length > 64)) {
    return json({ error: "bad_request", detail: "name" }, 400);
  }
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(publicKey);
    if (raw.length !== 32) throw new Error();
  } catch {
    return json({ error: "bad_request", detail: "publicKey" }, 400);
  }

  // Registration needs no account (self-signed keys), so every refusal below happens before
  // anything is written, the assertion's jti included: a new identity beyond the hourly cap,
  // and a known one asking for a new code more often than once per REREGISTER_MIN_SECONDS.
  const now = nowSeconds();
  const existing = await env.DB.prepare("SELECT robot_id, public_key, status, tunnel_id FROM robots WHERE robot_id = ?")
    .bind(await deriveRobotId(raw))
    .first<Pick<RobotRow, "robot_id" | "public_key" | "status" | "tunnel_id">>();
  const net = await networkKey(request);
  if (!existing && net) {
    const fromNet = await env.DB.prepare("SELECT COUNT(*) AS n FROM robots WHERE status = 'unclaimed' AND created_at > ? AND origin_net = ?")
      .bind(now - 3600, net)
      .first<{ n: number }>();
    if ((fromNet?.n ?? 0) >= NEW_ROBOTS_PER_NETWORK_PER_HOUR) return json({ error: "rate_limited" }, 429, { "Retry-After": "600" });
  }
  if (!existing && (await recentUnclaimed(env, now)) >= maxNewRobotsPerHour(env)) {
    await alert(env, "registration_cap", "The hourly cap on new robot registrations was reached. Normal for a launch, otherwise someone may be flooding the relay.");
    return json({ error: "rate_limited" }, 429, { "Retry-After": "600" });
  }

  let a: VerifiedAssertion;
  try {
    a = await verifyAssertion(env, request, url, async () => raw);
  } catch (e) {
    if (e instanceof AssertionError) return assertionFailure(e);
    throw e;
  }
  const robotId = a.robotId;
  const robotName = typeof name === "string" ? cleanLabel(name) : null;

  if (existing) {
    if (existing.public_key !== publicKey) return json({ error: "key_mismatch" }, 409);
    if (existing.status === "claimed") return json({ error: "already_claimed" }, 409);
    if (existing.status === "revoked" && existing.tunnel_id) return json({ error: "cleanup_pending" }, 503, { "Retry-After": "60" });
    const recent = await env.DB.prepare("SELECT 1 AS ok FROM pairing_codes WHERE robot_id = ? AND created_at > ?")
      .bind(robotId, now - REREGISTER_MIN_SECONDS)
      .first();
    if (recent) return json({ error: "rate_limited" }, 429, { "Retry-After": String(REREGISTER_MIN_SECONDS) });
    try {
      await consumeJti(env, a);
    } catch (e) {
      if (e instanceof AssertionError) return assertionFailure(e);
      throw e;
    }
    await env.DB.prepare("UPDATE robots SET status = 'unclaimed', name = ?, updated_at = ?, last_seen_at = ? WHERE robot_id = ?")
      .bind(robotName, now, now, robotId)
      .run();
  } else {
    // Registration is unauthenticated (self-signed keys), so bound how fast new robot rows can
    // appear; the count and insert are one statement so concurrent requests cannot overshoot.
    // Unclaimed rows are deleted after 7 days idle, which caps the table size.
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO robots (robot_id, public_key, name, status, session_epoch, created_at, updated_at, last_seen_at, origin_net)
       SELECT ?1, ?2, ?3, 'unclaimed', 1, ?4, ?4, ?4, ?7
       WHERE (SELECT COUNT(*) FROM robots WHERE status = 'unclaimed' AND created_at > ?5) < ?6
         AND (?7 IS NULL OR (SELECT COUNT(*) FROM robots WHERE status = 'unclaimed' AND created_at > ?5 AND origin_net = ?7) < ?8)`,
    )
      .bind(robotId, publicKey, robotName, now, now - 3600, maxNewRobotsPerHour(env), net, NEW_ROBOTS_PER_NETWORK_PER_HOUR)
      .run();
    if (ins.meta.changes !== 1) return json({ error: "rate_limited" }, 429, { "Retry-After": "600" });
    try {
      await consumeJti(env, a);
    } catch (e) {
      if (e instanceof AssertionError) return assertionFailure(e);
      throw e;
    }
  }

  // Re-register invalidates any previous code.
  const code = generatePairingCode();
  const expiresAt = now + PAIRING_TTL_SECONDS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pairing_codes WHERE robot_id = ?").bind(robotId),
    env.DB.prepare("INSERT INTO pairing_codes (code_hash, robot_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await hashPairingCode(env, code),
      robotId,
      now,
      expiresAt,
    ),
  ]);
  return json({
    robotId,
    pairingCode: formatPairingCode(code),
    claimUrl: `${env.RELAY_ORIGIN}/claim?code=${code}`,
    expiresAt,
  });
}

export async function robotSelf(env: Env, request: Request, url: URL): Promise<Response> {
  let a: VerifiedAssertion;
  try {
    a = await authenticate(env, request, url, async (iss) => {
      const r = await env.DB.prepare("SELECT public_key FROM robots WHERE robot_id = ?").bind(iss).first<{ public_key: string }>();
      return r ? b64urlDecode(r.public_key) : null;
    });
  } catch (e) {
    if (e instanceof AssertionError) return assertionFailure(e, 404);
    throw e;
  }
  const robot = await loadRobot(env, a.robotId);
  if (!robot) return json({ error: "unknown_robot" }, 404);

  const now = nowSeconds();
  const info = parseAgentHeader(request.headers.get("MC-Agent"));
  const infoChanged = info && (info.version !== robot.agent_version || info.teleop !== robot.allow_teleop);
  // last_seen_at only drives the 7-day cleanup of unclaimed robots, so refresh it every 15 minutes
  // rather than on every poll (D1 row writes are the Free plan's tightest limit).
  if (now - robot.last_seen_at > LAST_SEEN_REFRESH_SECONDS || infoChanged) {
    await env.DB.prepare("UPDATE robots SET last_seen_at = ?, agent_version = ?, allow_teleop = ? WHERE robot_id = ?")
      .bind(now, info?.version ?? robot.agent_version, info ? info.teleop : robot.allow_teleop, a.robotId)
      .run();
  }
  return selfResponse(env, a.robotId, robot);
}

const LAST_SEEN_REFRESH_SECONDS = 15 * 60;

/** `MC-Agent: version=1.2.3; teleop=on|off` (informational; set by the robot's own agent). */
export function parseAgentHeader(h: string | null): { version: string; teleop: number } | null {
  const m = /^version=([A-Za-z0-9._+-]{1,40}); teleop=(on|off)$/.exec(h ?? "");
  return m ? { version: m[1]!, teleop: m[2] === "on" ? 1 : 0 } : null;
}

function loadRobot(env: Env, robotId: string): Promise<RobotRow | null> {
  return env.DB.prepare(
    "SELECT robot_id, status, session_epoch, hostname, tunnel_token, last_seen_at, agent_version, allow_teleop FROM robots WHERE robot_id = ?",
  )
    .bind(robotId)
    .first<RobotRow>();
}

async function selfResponse(env: Env, robotId: string, robot: RobotRow): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT m.user_id, m.role, u.login FROM members m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.robot_id = ? ORDER BY m.created_at, m.user_id`,
  )
    .bind(robotId)
    .all<{ user_id: string; role: string; login: string | null }>();
  // Everyone's access to a robot follows its owner's: when the owner may no longer own robots
  // (removed by the admin), the robot accepts nobody, the people it is shared with included, and
  // their open sessions on it end at its next sync. Shares the admin removed are gone from the
  // table. One check per poll, and no writes (the poll is the relay's busiest path).
  const owner = rows.results.find((m) => m.role === "owner");
  const ownerOk = owner !== undefined && owner.login !== null && (await canOwn(env, owner.user_id, owner.login));
  const members = ownerOk ? rows.results.filter((m) => m.login !== null) : [];
  const key = await loadRelayKey(env);
  const claimed = robot.status === "claimed";
  return json({
    robotId: robot.robot_id,
    status: robot.status,
    hostname: claimed ? robot.hostname : null,
    tunnelToken: claimed ? await openToken(env, robotId, robot.tunnel_token) : null,
    relayKeys: [{ kid: key.kid, publicKey: key.publicKeyB64 }],
    sessionEpoch: robot.session_epoch,
    members: claimed ? members.map((m) => ({ userId: m.user_id, role: m.role })) : [],
  });
}

// Quick Tunnel hostnames only (docs/protocol.md, "Quick-tunnel mode"); input is lowercased first.
const QUICK_HOSTNAME = /^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$/;

export async function reportHostname(env: Env, request: Request, url: URL): Promise<Response> {
  let a: VerifiedAssertion;
  try {
    a = await authenticate(env, request, url, async (iss) => {
      const r = await env.DB.prepare("SELECT public_key FROM robots WHERE robot_id = ?").bind(iss).first<{ public_key: string }>();
      return r ? b64urlDecode(r.public_key) : null;
    });
  } catch (e) {
    if (e instanceof AssertionError) return assertionFailure(e, 404);
    throw e;
  }
  const robot = await loadRobot(env, a.robotId);
  if (!robot) return json({ error: "unknown_robot" }, 404);
  if (robot.status !== "claimed") return json({ error: "not_claimed" }, 409);
  if (env.PROVISIONER !== "quick") return json({ error: "not_quick_mode" }, 409);

  const body = await readJson(request);
  const raw = body?.hostname;
  const hostname = typeof raw === "string" ? raw.toLowerCase() : "";
  if (hostname.length > 253 || !QUICK_HOSTNAME.test(hostname)) return json({ error: "bad_request", detail: "hostname" }, 400);

  const now = nowSeconds();
  try {
    const upd = await env.DB.prepare(
      "UPDATE robots SET hostname = ?, updated_at = ?, last_seen_at = ? WHERE robot_id = ? AND status = 'claimed'",
    )
      .bind(hostname, now, now, a.robotId)
      .run();
    if (upd.meta.changes !== 1) return json({ error: "not_claimed" }, 409);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return json({ error: "hostname_taken" }, 409);
    throw e;
  }
  const fresh = await loadRobot(env, a.robotId);
  return fresh ? selfResponse(env, a.robotId, fresh) : json({ error: "unknown_robot" }, 404);
}
