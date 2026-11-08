import type { Env } from "./env";
import { signJws } from "./crypto";
import { loadRelayKey } from "./relayKey";
import { nowSeconds, randomToken } from "./util";

export const GRANT_TTL_SECONDS = 60;

export interface GrantInput {
  robotId: string;
  userId: string;
  name: string;
  role: "owner" | "viewer";
  epoch: number;
}

export async function mintGrant(env: Env, g: GrantInput, now = nowSeconds()): Promise<string> {
  const key = await loadRelayKey(env);
  return signJws(
    { alg: "EdDSA", typ: "mc-grant+jwt", kid: key.kid },
    {
      iss: env.RELAY_ORIGIN,
      aud: `mc-robot:${g.robotId}`,
      sub: g.userId,
      name: g.name,
      role: g.role,
      epoch: g.epoch,
      iat: now,
      exp: now + GRANT_TTL_SECONDS,
      jti: randomToken(16),
    },
    key.privateKey,
  );
}
