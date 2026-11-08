import { isUserAllowed, ownedRobots, robotLimit } from "./access";
import { alert } from "./alerts";
import type { Env } from "./env";
import { sealToken } from "./tokenSeal";
import { hashPairingCode, normalizePairingCode } from "./pairing";
import { HostnameInUseError, robotHostname, robotSubdomain, type TunnelProvisioner } from "./provisioner";
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

export function limitMessage(limit: number): string {
  return limit === 0
    ? "Your account cannot add robots. Ask the person who runs Mowgli Connect to raise your limit."
    : `You already have ${limit} ${limit === 1 ? "robot" : "robots"}, the most your account can have. Unlink one, or ask the person who runs Mowgli Connect to raise your limit.`;
}

function limitReached(limit: number): Failure {
  return { ok: false, status: 403, message: limitMessage(limit) };
}

/** The robot limit this person has reached, or null if they can add another robot. */
export async function reachedLimit(env: Env, userId: string): Promise<number | null> {
  const limit = await robotLimit(env, userId);
  if (limit === null) return null;
  return (await ownedRobots(env, userId)) >= limit ? limit : null;
}

const MAX_NAME_SUFFIX = 9;

/** "front-lawn", then "front-lawn-2" ... "front-lawn-9": readable names to try, in order. */
export function hostnameCandidates(name: string | null): string[] {
  const base = robotSubdomain(name);
  if (!base) return [];
  const out = [base];
  for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
    const c = robotSubdomain(`${base.slice(0, 32 - 2).replace(/-+$/, "")}-${n}`);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function zoneOf(env: Env): string {
  return (env.ROBOT_ZONE ?? "").replace(/^\.+|\.+$/g, "").toLowerCase();
}

/** A readable name this robot already holds from an earlier, unfinished attempt to add it. */
function heldLabel(hostname: string | null, zone: string): string | null {
  if (!hostname || !zone || !hostname.endsWith(`.${zone}`)) return null;
  const l = hostname.slice(0, -zone.length - 1);
  return robotSubdomain(l) === l ? l : null;
}

export interface AddressPlan {
  /** The address the robot will most likely get. */
  hostname: string;
  /** The readable name the owner asked for, when it is taken and another one is shown instead. */
  taken: string | null;
}

/**
 * The address a robot would get if added now with this name, for the confirmation page. Adding it
 * re-checks, so a name taken in the meantime moves on to the next free one.
 */
export async function planAddress(
  env: Env,
  provisioner: TunnelProvisioner,
  robotId: string,
  name: string | null,
): Promise<AddressPlan | null> {
  const zone = zoneOf(env);
  if (!provisioner.assignsHostnames || !zone) return null;
  const robot = await env.DB.prepare("SELECT hostname FROM robots WHERE robot_id = ?").bind(robotId).first<{ hostname: string | null }>();
  const held = heldLabel(robot?.hostname ?? null, zone);
  if (held) return { hostname: robotHostname(held, zone), taken: null };
  const candidates = hostnameCandidates(name);
  if (candidates.length === 0) return { hostname: robotHostname(robotId, zone), taken: null };
  const names = candidates.map((c) => robotHostname(c, zone));
  const used = await env.DB.prepare(
    `SELECT hostname FROM robots WHERE robot_id != ? AND hostname IN (${names.map(() => "?").join(",")})`,
  )
    .bind(robotId, ...names)
    .all<{ hostname: string }>();
  const usedSet = new Set(used.results.map((r) => r.hostname));
  const free = names.find((h) => !usedSet.has(h));
  return { hostname: free ?? robotHostname(robotId, zone), taken: free === names[0] ? null : names[0]! };
}

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
  const full = await reachedLimit(env, userId);
  if (full !== null) return limitReached(full); // before the code is used, so it stays valid
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

  // Only while the robot is still unclaimed: somebody else may have added it in the meantime.
  const restoreCode = () =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO pairing_codes (code_hash, robot_id, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM robots WHERE robot_id = ?2 AND status = 'unclaimed')`,
    )
      .bind(codeHash, robotId, consumed.created_at, consumed.expires_at)
      .run();

  const status = await env.DB.prepare("SELECT status, name, hostname FROM robots WHERE robot_id = ?")
    .bind(robotId)
    .first<{ status: string; name: string | null; hostname: string | null }>();
  if (status?.status !== "unclaimed") {
    await recordClaimFailure(env, userId);
    return INVALID;
  }

  // A readable hostname (front-lawn.<zone>, else front-lawn-2 ... -9) when one is free, otherwise
  // the robot id. Each name is reserved on the robot row before any DNS change (hostname is
  // UNIQUE), so two robots can never be given the same name.
  let tunnel;
  try {
    tunnel = await provisionNamed(env, provisioner, robotId, label ?? status.name, status.hostname);
  } catch (e) {
    console.error("tunnel provisioning failed", robotId, e instanceof Error ? e.message : "unknown");
    await restoreCode(); // let the user retry with the same code
    await alert(env, "provision_failed", "Creating a robot's tunnel failed. Check the Cloudflare API token and the Worker logs.");
    return { ok: false, status: 502, message: "Could not provision the tunnel. Try again in a moment." };
  }

  const limit = await robotLimit(env, userId);
  // One transaction: only the winner of the status transition becomes owner.
  const [upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE robots SET status = 'claimed', session_epoch = session_epoch + 1, hostname = ?1, tunnel_id = ?2,
         dns_record_id = ?3, tunnel_token = ?4, updated_at = ?5, claimed_at = ?5, first_online_at = NULL
       WHERE robot_id = ?6 AND status = 'unclaimed'
         AND (?7 IS NULL OR (SELECT COUNT(*) FROM members m JOIN robots o ON o.robot_id = m.robot_id
                             WHERE m.user_id = ?8 AND m.role = 'owner' AND o.status = 'claimed') < ?7)`,
    ).bind(tunnel.hostname, tunnel.tunnelId, tunnel.dnsRecordId, await sealToken(env, robotId, tunnel.token), now, robotId, limit, userId),
    env.DB.prepare(
      "INSERT INTO members (robot_id, user_id, role, label, created_at) SELECT ?, ?, 'owner', ?, ? WHERE changes() > 0",
    ).bind(robotId, userId, label, now),
    env.DB.prepare("DELETE FROM pairing_codes WHERE robot_id = ?").bind(robotId),
  ]);
  if (upd?.meta.changes !== 1) {
    const still = await env.DB.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robotId).first<{ status: string }>();
    if (still?.status === "unclaimed") {
      // Another robot was added to this account at the same moment and filled its limit. Keep the
      // code valid. The tunnel and the reserved name stay with the robot and are reused when it is
      // added again: deleting them here could race with somebody else claiming the same robot
      // under a new code, and take down their tunnel.
      await restoreCode();
      return limitReached((await robotLimit(env, userId)) ?? 0);
    }
    // Lost a race; the tunnel (idempotent by name) now belongs to the winner, so leave it alone.
    await recordClaimFailure(env, userId);
    return INVALID;
  }
  // Access removed while the robot was being added: do not leave it owned by nobody usable.
  const who = await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(userId).first<{ login: string }>();
  if (!who || !(await isUserAllowed(env, userId, who.login))) {
    await unlinkRobot(env, provisioner, robotId);
    return { ok: false, status: 403, message: "Your account no longer has access." };
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

/** Reserves the first free readable name for the robot and provisions its tunnel under it. */
async function provisionNamed(
  env: Env,
  provisioner: TunnelProvisioner,
  robotId: string,
  name: string | null,
  hostname: string | null,
): Promise<Awaited<ReturnType<TunnelProvisioner["provision"]>>> {
  const zone = zoneOf(env);
  if (!provisioner.assignsHostnames || !zone) return provisioner.provision(robotId);
  const held = heldLabel(hostname, zone);
  // A name held from an earlier, unfinished attempt comes first, so its DNS record is reused.
  const candidates = held ? [held] : hostnameCandidates(name);
  for (const label of candidates) {
    if (label !== held) {
      try {
        const r = await env.DB.prepare("UPDATE robots SET hostname = ? WHERE robot_id = ? AND status = 'unclaimed'")
          .bind(robotHostname(label, zone), robotId)
          .run();
        if (r.meta.changes !== 1) continue;
      } catch {
        continue; // UNIQUE: taken by another robot
      }
    }
    try {
      return await provisioner.provision(robotId, label);
    } catch (e) {
      if (!(e instanceof HostnameInUseError)) throw e;
      // Something else in the zone uses this name: release it and try the next one.
      await env.DB.prepare("UPDATE robots SET hostname = NULL WHERE robot_id = ? AND status = 'unclaimed'").bind(robotId).run();
    }
  }
  return provisioner.provision(robotId);
}
