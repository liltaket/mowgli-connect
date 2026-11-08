import type { Env } from "./env";
import { hashPairingCode, normalizePairingCode } from "./pairing";
import { robotHostname, robotSubdomain, type TunnelProvisioner } from "./provisioner";
import { nowSeconds } from "./util";

export const CLAIM_FAILURES_PER_HOUR = 10;

type Failure = { ok: false; status: number; message: string };
export type ClaimResult = { ok: true; robotId: string } | Failure;

export async function claimRateLimited(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM claim_failures WHERE user_id = ? AND at > ?")
    .bind(userId, nowSeconds() - 3600)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= CLAIM_FAILURES_PER_HOUR;
}

export async function recordClaimFailure(env: Env, userId: string): Promise<void> {
  await env.DB.prepare("INSERT INTO claim_failures (user_id, at) VALUES (?, ?)").bind(userId, nowSeconds()).run();
}

const RATE_LIMITED: Failure = { ok: false, status: 429, message: "Too many failed attempts. Try again later." };
const INVALID: Failure = { ok: false, status: 400, message: "Invalid or expired pairing code." };

/** Look up (without consuming) the robot a pairing code belongs to. Failures count towards the rate limit. */
export async function previewClaim(
  env: Env,
  userId: string,
  rawCode: string,
): Promise<{ ok: true; robotId: string; name: string | null } | Failure> {
  if (await claimRateLimited(env, userId)) return RATE_LIMITED;
  const code = normalizePairingCode(rawCode);
  const row = code
    ? await env.DB.prepare(
        `SELECT r.robot_id, r.name FROM pairing_codes p JOIN robots r ON r.robot_id = p.robot_id
         WHERE p.code_hash = ? AND p.expires_at > ? AND r.status = 'unclaimed'`,
      )
        .bind(await hashPairingCode(code), nowSeconds())
        .first<{ robot_id: string; name: string | null }>()
    : null;
  if (!row) {
    await recordClaimFailure(env, userId);
    return INVALID;
  }
  return { ok: true, robotId: row.robot_id, name: row.name };
}

export async function claimRobot(
  env: Env,
  provisioner: TunnelProvisioner,
  userId: string,
  rawCode: string,
  label: string | null,
): Promise<ClaimResult> {
  if (await claimRateLimited(env, userId)) return RATE_LIMITED;
  const code = normalizePairingCode(rawCode);
  if (!code) {
    await recordClaimFailure(env, userId);
    return INVALID;
  }
  const codeHash = await hashPairingCode(code);
  const now = nowSeconds();

  // Single use: the DELETE is the atomic gate.
  const consumed = await env.DB.prepare(
    "DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ? RETURNING robot_id, created_at, expires_at",
  )
    .bind(codeHash, now)
    .first<{ robot_id: string; created_at: number; expires_at: number }>();
  if (!consumed) {
    await recordClaimFailure(env, userId);
    return INVALID;
  }
  const robotId = consumed.robot_id;

  const restoreCode = () =>
    env.DB.prepare("INSERT OR IGNORE INTO pairing_codes (code_hash, robot_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(codeHash, robotId, consumed.created_at, consumed.expires_at)
      .run();

  const status = await env.DB.prepare("SELECT status, name, hostname FROM robots WHERE robot_id = ?")
    .bind(robotId)
    .first<{ status: string; name: string | null; hostname: string | null }>();
  if (status?.status !== "unclaimed") {
    await recordClaimFailure(env, userId);
    return INVALID;
  }

  // A readable hostname (front-lawn.<zone>) when the name is free. It is reserved on the robot
  // row before any DNS change (hostname is UNIQUE), so two robots can never be given the same
  // name; otherwise the robot id is used.
  let hostLabel: string | undefined;
  if (provisioner.assignsHostnames) {
    const zone = (env.ROBOT_ZONE ?? "").replace(/^\.+|\.+$/g, "").toLowerCase();
    const reserved = status.hostname && zone && status.hostname.endsWith(`.${zone}`) ? status.hostname.slice(0, -zone.length - 1) : null;
    const wanted = robotSubdomain(label ?? status.name);
    if (reserved && robotSubdomain(reserved) === reserved) {
      hostLabel = reserved; // a previous attempt for this robot already holds a name
    } else if (wanted && zone) {
      try {
        const r = await env.DB.prepare("UPDATE robots SET hostname = ? WHERE robot_id = ? AND status = 'unclaimed'")
          .bind(robotHostname(wanted, zone), robotId)
          .run();
        if (r.meta.changes === 1) hostLabel = wanted;
      } catch {
        // UNIQUE: taken by another robot.
      }
    }
  }

  let tunnel;
  try {
    tunnel = await provisioner.provision(robotId, hostLabel);
  } catch (e) {
    console.error("tunnel provisioning failed", robotId, e instanceof Error ? e.message : "unknown");
    await restoreCode(); // let the user retry with the same code
    return { ok: false, status: 502, message: "Could not provision the tunnel. Try again in a moment." };
  }

  // One transaction: only the winner of the status transition becomes owner.
  const [upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE robots SET status = 'claimed', session_epoch = session_epoch + 1, hostname = ?, tunnel_id = ?,
         dns_record_id = ?, tunnel_token = ?, updated_at = ? WHERE robot_id = ? AND status = 'unclaimed'`,
    ).bind(tunnel.hostname, tunnel.tunnelId, tunnel.dnsRecordId, tunnel.token, now, robotId),
    env.DB.prepare(
      "INSERT INTO members (robot_id, user_id, role, label, created_at) SELECT ?, ?, 'owner', ?, ? WHERE changes() > 0",
    ).bind(robotId, userId, label, now),
    env.DB.prepare("DELETE FROM pairing_codes WHERE robot_id = ?").bind(robotId),
  ]);
  if (upd?.meta.changes !== 1) {
    // Lost a race; the tunnel (idempotent by name) now belongs to the winner, so leave it alone.
    await recordClaimFailure(env, userId);
    return INVALID;
  }
  return { ok: true, robotId };
}

/** Owner-only. Access is revoked in D1 first; Cloudflare cleanup failures are retried by the cron. */
export async function unlinkRobot(env: Env, provisioner: TunnelProvisioner, robotId: string): Promise<boolean> {
  const now = nowSeconds();
  const before = await env.DB.prepare("SELECT hostname, tunnel_id, dns_record_id FROM robots WHERE robot_id = ? AND status = 'claimed'")
    .bind(robotId)
    .first<{ hostname: string | null; tunnel_id: string | null; dns_record_id: string | null }>();
  if (!before) return false;
  const [upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE robots SET status = 'revoked', session_epoch = session_epoch + 1, tunnel_token = NULL, updated_at = ?
       WHERE robot_id = ? AND status = 'claimed'`,
    ).bind(now, robotId),
    env.DB.prepare("DELETE FROM members WHERE robot_id = ?").bind(robotId),
  ]);
  if (upd?.meta.changes !== 1) return false;
  await cleanupRevoked(env, provisioner, robotId, { robotId, ...camel(before) });
  return true;
}

function camel(r: { hostname: string | null; tunnel_id: string | null; dns_record_id: string | null }) {
  return { hostname: r.hostname, tunnelId: r.tunnel_id, dnsRecordId: r.dns_record_id };
}

export async function cleanupRevoked(
  env: Env,
  provisioner: TunnelProvisioner,
  robotId: string,
  ref: { robotId: string; hostname: string | null; tunnelId: string | null; dnsRecordId: string | null },
): Promise<boolean> {
  try {
    await provisioner.deprovision(ref);
  } catch (e) {
    console.error("tunnel cleanup failed (will retry)", robotId, e instanceof Error ? e.message : "unknown");
    return false;
  }
  await env.DB.prepare(
    "UPDATE robots SET hostname = NULL, tunnel_id = NULL, dns_record_id = NULL, updated_at = ? WHERE robot_id = ? AND status = 'revoked'",
  )
    .bind(nowSeconds(), robotId)
    .run();
  return true;
}

export async function retryPendingCleanups(env: Env, provisioner: TunnelProvisioner): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT robot_id, hostname, tunnel_id, dns_record_id FROM robots WHERE status = 'revoked' AND tunnel_id IS NOT NULL LIMIT 20",
  ).all<{ robot_id: string; hostname: string | null; tunnel_id: string | null; dns_record_id: string | null }>();
  for (const r of rows.results) await cleanupRevoked(env, provisioner, r.robot_id, { robotId: r.robot_id, ...camel(r) });
}
