import { afterSharesEnded, canOwn, ownedRobots, robotLimit } from "./access";
import { alert } from "./alerts";
import type { Env } from "./env";
import { sealToken, tokenKeyUsable } from "./tokenSeal";
import { normalizePairingCode, pairingCodeHashes } from "./pairing";
import { HostnameInUseError, robotHostname, robotSubdomain, type TunnelProvisioner } from "./provisioner";
import { nowSeconds } from "./util";

export const CLAIM_FAILURES_PER_HOUR = 10;

type Failure = { ok: false; status: number; message: string };
export type ClaimResult = { ok: true; robotId: string } | Failure;

/**
 * Whose hourly guess budget a claim attempt uses: the person's own by default. A delegate has its
 * own, smaller one (docs/agent-delegation.md), so a misbehaving agent cannot lock its person out.
 */
export interface GuessBudget {
  key: string;
  perHour: number;
}

/**
 * Reserves one guess from an hourly budget (CLAIM_FAILURES_PER_HOUR for a person) in a single
 * statement, so concurrent requests cannot all pass one count. The row stays as a failure unless
 * the attempt is released (a valid code, or a failure that was not a wrong guess). Returns null
 * when the budget is used up.
 */
async function reserveAttempt(env: Env, budget: GuessBudget): Promise<number | null> {
  const now = nowSeconds();
  const row = await env.DB.prepare(
    `INSERT INTO claim_failures (user_id, at)
     SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM claim_failures WHERE user_id = ?1 AND at > ?3) < ?4
     RETURNING id`,
  )
    .bind(budget.key, now, now - 3600, budget.perHour)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function releaseAttempt(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM claim_failures WHERE id = ?").bind(id).run();
}

/** Runs one pairing-code attempt against the budget; only a wrong or used code keeps counting. */
async function withAttempt<T extends { ok: boolean }>(env: Env, budget: GuessBudget, attempt: () => Promise<T | Failure>): Promise<T | Failure> {
  const id = await reserveAttempt(env, budget);
  if (id === null) return RATE_LIMITED;
  const res = await attempt();
  if (res !== INVALID) await releaseAttempt(env, id);
  return res;
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

/**
 * How long a released hostname rests before another robot may take it (the robot that had it
 * may take it back at once). Whatever the previous owner's robot served under the name (cached
 * by a browser, or a service worker registered in someone's browser) must not greet the next
 * owner; Cloudflare's edge cache is also bypassed for robot hostnames (relay/README.md).
 */
export const NAME_QUARANTINE_SECONDS = 90 * 86400;

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
  const marks = names.map(() => "?").join(",");
  const used = await env.DB.prepare(
    `SELECT hostname FROM robots WHERE robot_id != ? AND hostname IN (${marks})
     UNION SELECT hostname FROM released_hostnames WHERE robot_id != ? AND released_at > ? AND hostname IN (${marks})`,
  )
    .bind(robotId, ...names, robotId, nowSeconds() - NAME_QUARANTINE_SECONDS, ...names)
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
  budget: GuessBudget = { key: userId, perHour: CLAIM_FAILURES_PER_HOUR },
): Promise<{ ok: true; robotId: string; name: string | null } | Failure> {
  return withAttempt(env, budget, () => lookupCode(env, rawCode));
}

async function lookupCode(env: Env, rawCode: string): Promise<{ ok: true; robotId: string; name: string | null } | Failure> {
  const code = normalizePairingCode(rawCode);
  const row = code
    ? await env.DB.prepare(
        `SELECT r.robot_id, r.name FROM pairing_codes p JOIN robots r ON r.robot_id = p.robot_id
         WHERE p.code_hash IN (?1, ?2) AND p.expires_at > ?3 AND r.status = 'unclaimed'`,
      )
        .bind(...(await pairingCodeHashes(env, code)), nowSeconds())
        .first<{ robot_id: string; name: string | null }>()
    : null;
  if (!row) return INVALID;
  return { ok: true, robotId: row.robot_id, name: row.name };
}

export async function claimRobot(
  env: Env,
  provisioner: TunnelProvisioner,
  userId: string,
  rawCode: string,
  label: string | null,
  budget: GuessBudget = { key: userId, perHour: CLAIM_FAILURES_PER_HOUR },
  delegationId: string | null = null,
): Promise<ClaimResult> {
  return withAttempt(env, budget, () => claimWithCode(env, provisioner, userId, rawCode, label, delegationId));
}

async function claimWithCode(
  env: Env,
  provisioner: TunnelProvisioner,
  userId: string,
  rawCode: string,
  label: string | null,
  delegationId: string | null,
): Promise<ClaimResult> {
  const code = normalizePairingCode(rawCode);
  if (!code) return INVALID;
  const full = await reachedLimit(env, userId);
  if (full !== null) return limitReached(full); // before the code is used, so it stays valid
  if (!tokenKeyUsable(env)) {
    await alert(env, "token_key_invalid", "TUNNEL_TOKEN_KEY is not valid (32 bytes, base64url), so no robot can be added. Set the secret again.");
    return { ok: false, status: 503, message: "Robots cannot be added right now. Try again later." };
  }
  const now = nowSeconds();

  // Single use: the DELETE is the atomic gate.
  const consumed = await env.DB.prepare(
    "DELETE FROM pairing_codes WHERE code_hash IN (?1, ?2) AND expires_at > ?3 RETURNING code_hash, robot_id, created_at, expires_at",
  )
    .bind(...(await pairingCodeHashes(env, code)), now)
    .first<{ code_hash: string; robot_id: string; created_at: number; expires_at: number }>();
  if (!consumed) return INVALID;
  const robotId = consumed.robot_id;
  const codeHash = consumed.code_hash;

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
    return INVALID;
  }

  // A readable hostname (front-lawn.<zone>, else front-lawn-2 ... -9) when one is free, otherwise
  // the robot id. Each name is reserved on the robot row before any DNS change (hostname is
  // UNIQUE), so two robots can never be given the same name.
  let tunnel;
  let sealed: string | null;
  try {
    tunnel = await provisionNamed(env, provisioner, robotId, label ?? status.name, status.hostname);
    sealed = await sealToken(env, robotId, tunnel.token);
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
                             WHERE m.user_id = ?8 AND m.role = 'owner' AND o.status = 'claimed') < ?7)
         -- A delegate's claim needs its delegation still active, with robots:claim, at this moment:
         -- provisioning above takes seconds, so the expiry is compared with the time now (?10), not
         -- with when the claim started (security review 14 and the final review).
         AND (?9 IS NULL OR EXISTS (SELECT 1 FROM delegations WHERE delegation_id = ?9 AND user_id = ?8 AND revoked_at IS NULL
                                      AND expires_at > ?10 AND (' ' || scopes || ' ') LIKE '% robots:claim %'))`,
    ).bind(tunnel.hostname, tunnel.tunnelId, tunnel.dnsRecordId, sealed, now, robotId, limit, userId, delegationId, nowSeconds()),
    env.DB.prepare(
      "INSERT INTO members (robot_id, user_id, role, label, created_at) SELECT ?, ?, 'owner', ?, ? WHERE changes() > 0",
    ).bind(robotId, userId, label, now),
    // A delegate's claim puts the robot in its set in the same transaction, only if this claim won
    // (changes() of the member insert), so a late write cannot bring back a robot that was
    // unlinked and added again meanwhile (security review 14).
    env.DB.prepare(
      "INSERT OR REPLACE INTO delegation_robots (delegation_id, robot_id, via, added_at) SELECT ?1, ?2, 'claim', ?3 WHERE ?1 IS NOT NULL AND changes() > 0",
    ).bind(delegationId, robotId, now),
    env.DB.prepare("DELETE FROM pairing_codes WHERE robot_id = ?").bind(robotId),
  ]);
  if (upd?.meta.changes !== 1) {
    const still = await env.DB.prepare("SELECT status FROM robots WHERE robot_id = ?").bind(robotId).first<{ status: string }>();
    if (still?.status === "unclaimed" && delegationId !== null) {
      const active = await env.DB.prepare(
        "SELECT 1 AS ok FROM delegations WHERE delegation_id = ? AND revoked_at IS NULL AND expires_at > ? AND (' ' || scopes || ' ') LIKE '% robots:claim %'",
      )
        .bind(delegationId, nowSeconds())
        .first();
      if (!active) {
        await restoreCode(); // the person may still add it
        return { ok: false, status: 403, message: "This agent's access ended while the robot was being added." };
      }
    }
    if (still?.status === "unclaimed") {
      // Another robot was added to this account at the same moment and filled its limit, or the
      // person lost access while the tunnel was being made (their limit is now 0). Keep the code
      // valid. The tunnel (named after the robot id) and the reserved name stay with the robot
      // row and are reused when it is added again: deleting them here could race with somebody
      // else claiming the same robot under a new code, and take down their tunnel.
      await restoreCode();
      return limitReached((await robotLimit(env, userId)) ?? 0);
    }
    // Lost a race; the tunnel (idempotent by name) now belongs to the winner, so leave it alone.
    return INVALID;
  }
  // Access removed between reading the limit and here: do not leave the robot owned by nobody
  // usable. Unlinking deletes its tunnel (retried by the cron).
  const who = await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(userId).first<{ login: string }>();
  if (!who || !(await canOwn(env, userId, who.login))) {
    await unlinkRobot(env, provisioner, robotId);
    return { ok: false, status: 403, message: "Your account no longer has access." };
  }
  return { ok: true, robotId };
}

/**
 * What must still hold when the unlink commits, checked in the same statement: `ownerId` still
 * owns the robot and, for a delegate, the delegation is active with robots:manage and still has the
 * robot in its set. A request authorized earlier cannot unlink a robot that was unlinked and added
 * again (by anyone) in the meantime (security review 14).
 */
export interface UnlinkGuard {
  ownerId: string;
  delegationId?: string;
}

/** Owner-only. Access is revoked in D1 first; Cloudflare cleanup failures are retried by the cron. */
export async function unlinkRobot(
  env: Env,
  provisioner: TunnelProvisioner,
  robotId: string,
  opts: { onlyIfOwnerNotInvited?: boolean; guard?: UnlinkGuard } = {},
): Promise<boolean> {
  const guests = await revokeRobot(env, provisioner, robotId, opts);
  if (guests === null) return false;
  // The people it was shared with lost that share like any other: for a guest's last one, end
  // their relay sessions and app devices now, so they do not come back with a later share.
  await afterSharesEnded(env, guests);
  return true;
}

/**
 * unlinkRobot without the guests' cleanup, for unlinking many robots at once: returns the people
 * it was shared with (for afterSharesEnded), or null when it was not unlinked.
 */
export async function revokeRobot(
  env: Env,
  provisioner: TunnelProvisioner,
  robotId: string,
  opts: { onlyIfOwnerNotInvited?: boolean; guard?: UnlinkGuard } = {},
): Promise<string[] | null> {
  const now = nowSeconds();
  const before = await env.DB.prepare("SELECT hostname, tunnel_id, dns_record_id FROM robots WHERE robot_id = ? AND status = 'claimed'")
    .bind(robotId)
    .first<{ hostname: string | null; tunnel_id: string | null; dns_record_id: string | null }>();
  if (!before) return null;
  const [upd, del] = await env.DB.batch<{ user_id: string; role: string }>([
    env.DB.prepare(
      `UPDATE robots SET status = 'revoked', session_epoch = session_epoch + 1, tunnel_token = NULL, updated_at = ?1
       WHERE robot_id = ?2 AND status = 'claimed'
         AND (?3 = 0 OR NOT EXISTS (SELECT 1 FROM members m JOIN invites i ON i.user_id = m.user_id
                                    WHERE m.robot_id = ?2 AND m.role = 'owner'))
         AND (?4 IS NULL OR EXISTS (SELECT 1 FROM members WHERE robot_id = ?2 AND user_id = ?4 AND role = 'owner'))
         AND (?5 IS NULL OR (EXISTS (SELECT 1 FROM delegation_robots WHERE delegation_id = ?5 AND robot_id = ?2)
                             AND EXISTS (SELECT 1 FROM delegations WHERE delegation_id = ?5 AND user_id = ?4 AND revoked_at IS NULL
                                           AND expires_at > ?1 AND (' ' || scopes || ' ') LIKE '% robots:manage %')))`,
    ).bind(now, robotId, opts.onlyIfOwnerNotInvited ? 1 : 0, opts.guard?.ownerId ?? null, opts.guard?.delegationId ?? null),
    // In the same transaction, and only if the robot was just revoked.
    env.DB.prepare("DELETE FROM members WHERE robot_id = ? AND changes() > 0 RETURNING user_id, role").bind(robotId),
    // No delegation keeps an unlinked robot in its robot set, so a robot added again later (by
    // anyone) does not come back to an agent (docs/agent-delegation.md).
    env.DB.prepare(
      "DELETE FROM delegation_robots WHERE robot_id = ?1 AND EXISTS (SELECT 1 FROM robots WHERE robot_id = ?1 AND status = 'revoked')",
    ).bind(robotId),
  ]);
  if (upd?.meta.changes !== 1) return null;
  await cleanupRevoked(env, provisioner, robotId, { robotId, ...camel(before) });
  return (del?.results ?? []).filter((m) => m.role !== "owner").map((m) => m.user_id);
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
  const now = nowSeconds();
  await env.DB.batch([
    // The name rests before another robot may take it (NAME_QUARANTINE_SECONDS).
    env.DB.prepare(
      `INSERT INTO released_hostnames (hostname, robot_id, released_at)
       SELECT hostname, robot_id, ?1 FROM robots WHERE robot_id = ?2 AND status = 'revoked' AND hostname IS NOT NULL
       ON CONFLICT(hostname) DO UPDATE SET robot_id = excluded.robot_id, released_at = excluded.released_at`,
    ).bind(now, robotId),
    env.DB.prepare(
      "UPDATE robots SET hostname = NULL, tunnel_id = NULL, dns_record_id = NULL, updated_at = ? WHERE robot_id = ? AND status = 'revoked'",
    ).bind(now, robotId),
  ]);
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
        const r = await env.DB.prepare(
          `UPDATE robots SET hostname = ?1 WHERE robot_id = ?2 AND status = 'unclaimed'
             AND NOT EXISTS (SELECT 1 FROM released_hostnames WHERE hostname = ?1 AND robot_id != ?2 AND released_at > ?3)`,
        )
          .bind(robotHostname(label, zone), robotId, nowSeconds() - NAME_QUARANTINE_SECONDS)
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
