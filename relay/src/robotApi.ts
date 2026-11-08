import type { Env } from "./env";
import { AssertionError, verifyRobotAssertion, type VerifiedAssertion } from "./assertion";
import { b64urlDecode } from "./crypto";
import { loadRelayKey } from "./relayKey";
import { formatPairingCode, generatePairingCode, hashPairingCode, PAIRING_TTL_SECONDS } from "./pairing";
import { SECURITY_HEADERS } from "./html";
import { cleanLabel, nowSeconds, readBodyText, SKEW_SECONDS } from "./util";

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
}

async function authenticate(
  env: Env,
  request: Request,
  url: URL,
  resolveKey: (iss: string) => Promise<Uint8Array | null>,
): Promise<VerifiedAssertion> {
  const a = await verifyRobotAssertion({
    authorization: request.headers.get("Authorization"),
    method: request.method,
    htu: `${env.RELAY_ORIGIN}${url.pathname}`,
    aud: env.RELAY_ORIGIN,
    now: nowSeconds(),
    resolveKey,
  });
  // Single use. Stored until exp + skew so a replay inside the accepted window is still rejected.
  const res = await env.DB.prepare("INSERT OR IGNORE INTO jti_seen (robot_id, jti, expires_at) VALUES (?, ?, ?)")
    .bind(a.robotId, a.jti, a.exp + SKEW_SECONDS)
    .run();
  if (res.meta.changes !== 1) throw new AssertionError("replayed_jti");
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

  let a: VerifiedAssertion;
  try {
    a = await authenticate(env, request, url, async () => raw);
  } catch (e) {
    if (e instanceof AssertionError) return assertionFailure(e);
    throw e;
  }
  const robotId = a.robotId;
  const now = nowSeconds();
  const robotName = typeof name === "string" ? cleanLabel(name) : null;

  const existing = await env.DB.prepare("SELECT robot_id, public_key, status, tunnel_id FROM robots WHERE robot_id = ?")
    .bind(robotId)
    .first<Pick<RobotRow, "robot_id" | "public_key" | "status" | "tunnel_id">>();

  if (existing) {
    if (existing.public_key !== publicKey) return json({ error: "key_mismatch" }, 409);
    if (existing.status === "claimed") return json({ error: "already_claimed" }, 409);
    if (existing.status === "revoked" && existing.tunnel_id) return json({ error: "cleanup_pending" }, 503, { "Retry-After": "60" });
    await env.DB.prepare("UPDATE robots SET status = 'unclaimed', name = ?, updated_at = ?, last_seen_at = ? WHERE robot_id = ?")
      .bind(robotName, now, now, robotId)
      .run();
  } else {
    // Registration is unauthenticated (self-signed keys), so bound how fast new robot rows can
    // appear. Unclaimed rows are deleted after 7 days idle, which caps the table size.
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM robots WHERE status = 'unclaimed' AND created_at > ?")
      .bind(now - 3600)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= maxNewRobotsPerHour(env)) {
      return json({ error: "rate_limited" }, 429, { "Retry-After": "600" });
    }
    await env.DB.prepare(
      `INSERT INTO robots (robot_id, public_key, name, status, session_epoch, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, 'unclaimed', 1, ?, ?, ?)`,
    )
      .bind(robotId, publicKey, robotName, now, now, now)
      .run();
  }

  // Re-register invalidates any previous code.
  const code = generatePairingCode();
  const expiresAt = now + PAIRING_TTL_SECONDS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pairing_codes WHERE robot_id = ?").bind(robotId),
    env.DB.prepare("INSERT INTO pairing_codes (code_hash, robot_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await hashPairingCode(code),
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
  if (now - robot.last_seen_at > 30) {
    await env.DB.prepare("UPDATE robots SET last_seen_at = ? WHERE robot_id = ?").bind(now, a.robotId).run();
  }
  return selfResponse(env, a.robotId, robot);
}

function loadRobot(env: Env, robotId: string): Promise<RobotRow | null> {
  return env.DB.prepare(
    "SELECT robot_id, status, session_epoch, hostname, tunnel_token, last_seen_at FROM robots WHERE robot_id = ?",
  )
    .bind(robotId)
    .first<RobotRow>();
}

async function selfResponse(env: Env, robotId: string, robot: RobotRow): Promise<Response> {
  const members = await env.DB.prepare("SELECT user_id, role FROM members WHERE robot_id = ? ORDER BY created_at, user_id")
    .bind(robotId)
    .all<{ user_id: string; role: string }>();
  const key = await loadRelayKey(env);
  const claimed = robot.status === "claimed";
  return json({
    robotId: robot.robot_id,
    status: robot.status,
    hostname: claimed ? robot.hostname : null,
    tunnelToken: claimed ? robot.tunnel_token : null,
    relayKeys: [{ kid: key.kid, publicKey: key.publicKeyB64 }],
    sessionEpoch: robot.session_epoch,
    members: claimed ? members.results.map((m) => ({ userId: m.user_id, role: m.role })) : [],
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
