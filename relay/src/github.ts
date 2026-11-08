import type { Env } from "./env";

/** A GitHub login: letters, digits and single dashes, at most 39 characters. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  createdAt: string | null;
}

export type LookupResult = { ok: true; user: GithubProfile } | { ok: false; reason: "not_found" | "not_a_user" | "unavailable" };

/**
 * Looks up a public GitHub profile by login or numeric id, for the admin page. It uses the OAuth
 * app's own credentials (GitHub's higher rate limit for apps) and never a user's token.
 */
export async function lookupGithubUser(env: Env, by: { login: string } | { id: number }): Promise<LookupResult> {
  const path = "login" in by ? `/users/${encodeURIComponent(by.login)}` : `/user/${by.id}`;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "mowgli-connect-relay",
      },
      // Workers support only "follow" and "manual"; a redirect is not followed and counts as a
      // failure below (any 3xx is not ok).
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (!res.ok) return { ok: false, reason: "unavailable" };
  let j: Record<string, unknown>;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const id = j.id;
  const login = j.login;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof login !== "string" || !GITHUB_LOGIN.test(login)) {
    return { ok: false, reason: "unavailable" };
  }
  if (j.type !== "User") return { ok: false, reason: "not_a_user" };
  return {
    ok: true,
    user: {
      id,
      login,
      name: typeof j.name === "string" && j.name.trim() ? j.name.trim().slice(0, 100) : null,
      createdAt: typeof j.created_at === "string" ? j.created_at : null,
    },
  };
}
