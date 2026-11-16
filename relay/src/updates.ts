import type { Env } from "./env";
import { securityAlert } from "./alerts";
import { nowSeconds } from "./util";

/**
 * Which agent version is current: the commit of the newest successful image build on the default
 * branch (that build publishes :latest). Checked by the cron at most hourly, with the OAuth app's
 * credentials, and kept in `settings`.
 */

const CHECK_EVERY_SECONDS = 3600;
const DEFAULT_REPO = "liltaket/mowgli-connect";
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export async function refreshLatestAgent(env: Env): Promise<void> {
  const now = nowSeconds();
  const checked = await env.DB.prepare("SELECT value FROM settings WHERE key = 'latest_agent_checked'").first<{ value: string }>();
  if (checked && now - Number(checked.value) < CHECK_EVERY_SECONDS) return;
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('latest_agent_checked', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(String(now))
    .run();
  const repo = env.AGENT_IMAGE_REPO && REPO.test(env.AGENT_IMAGE_REPO) ? env.AGENT_IMAGE_REPO : DEFAULT_REPO;
  try {
    await watchAgentImage(env, repo);
  } catch (e) {
    console.error("agent image watch skipped", e instanceof Error ? e.message : "unknown");
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/agent-image.yml/runs?branch=main&status=success&per_page=10`, {
    headers: {
      Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "mowgli-connect-relay",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return;
  const j = (await res.json()) as { workflow_runs?: { head_sha?: unknown; event?: unknown }[] };
  const run = (j.workflow_runs ?? []).find((r) => r.event === "push" || r.event === "workflow_dispatch");
  const sha = run?.head_sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return;
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('latest_agent_sha', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(sha)
    .run();
}

export async function latestAgentSha(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'latest_agent_sha'").first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Whether a robot's reported agent version (from its MC-Agent header, "main-<commit>", cut to 40
 * characters) is older than the latest build. null when it cannot be told (a local or tagged build).
 */
export function updateAvailable(version: string | null, latest: string | null): boolean | null {
  if (!version || !latest) return null;
  const m = /^main-([0-9a-f]{7,40})$/.exec(version);
  if (!m) return null;
  return !latest.startsWith(m[1]!);
}

/**
 * Release alarm (docs/security-maintenance.md): what robots will install next night is whatever
 * `:latest` of the agent image points to in GHCR. The relay checks that digest every hour, from
 * Cloudflare and without any GitHub credential, and sends a security alert whenever it changes.
 * So a release nobody expected is noticed even if the GitHub account, the repository or its
 * workflows (which send their own release alert) are in someone else's hands. The first digest
 * seen is only recorded.
 */
export async function watchAgentImage(env: Env, repo: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const image = `${repo.split("/")[0]!.toLowerCase()}/mowgli-connect-agent`;
  const tok = await fetchFn(`https://ghcr.io/token?scope=repository:${image}:pull&service=ghcr.io`, {
    headers: { "User-Agent": "mowgli-connect-relay" },
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
  });
  if (!tok.ok) return;
  const token = ((await tok.json()) as { token?: unknown }).token;
  if (typeof token !== "string" || !token) return;
  const res = await fetchFn(`https://ghcr.io/v2/${image}/manifests/latest`, {
    method: "HEAD",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json",
      "User-Agent": "mowgli-connect-relay",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
  });
  const digest = res.headers.get("Docker-Content-Digest") ?? "";
  if (!res.ok || !/^sha256:[0-9a-f]{64}$/.test(digest)) return;
  const prev = await env.DB.prepare("SELECT value FROM settings WHERE key = 'agent_image_latest'").first<{ value: string }>();
  if (prev?.value === digest) return;
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('agent_image_latest', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(digest)
    .run();
  if (!prev) return;
  await securityAlert(
    env,
    "agent_release",
    `New agent release: ghcr.io/${image}:latest is now ${digest.slice(0, 19)}. Robots with automatic updates install it tonight. ` +
      "If you did not merge a change to main, pause agent updates and engage the emergency stop on the admin page now.",
  );
}
