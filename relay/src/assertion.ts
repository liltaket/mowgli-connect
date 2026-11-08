import { deriveRobotId, importEd25519Public, JwsError, parseJws, verifyJws } from "./crypto";
import { SKEW_SECONDS } from "./util";

export class AssertionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface VerifiedAssertion {
  robotId: string;
  jti: string;
  exp: number;
}

export interface VerifyOptions {
  authorization: string | null;
  method: string;
  /** Expected htu: relay origin + request path (no query/fragment). */
  htu: string;
  /** Expected aud: relay origin. */
  aud: string;
  now: number;
  /** Raw public key for an issuer, or null if unknown. */
  resolveKey: (iss: string) => Promise<Uint8Array | null>;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** Verifies an `Authorization: MC-Robot <jws>` assertion. Does NOT consume the jti. */
export async function verifyRobotAssertion(o: VerifyOptions): Promise<VerifiedAssertion> {
  const m = /^MC-Robot ([^\s]+)$/.exec(o.authorization ?? "");
  if (!m) throw new AssertionError("missing_assertion");
  let parsed;
  try {
    parsed = parseJws(m[1]!);
  } catch (e) {
    throw new AssertionError(e instanceof JwsError ? "malformed" : "malformed");
  }
  if (parsed.header.alg !== "EdDSA" || parsed.header.typ !== "mc-robot+jwt") throw new AssertionError("bad_header");

  const c = parsed.payload;
  const iss = c.iss;
  if (typeof iss !== "string" || !/^[a-z2-7]{16}$/.test(iss)) throw new AssertionError("bad_iss");

  const raw = await o.resolveKey(iss);
  if (!raw) throw new AssertionError("unknown_robot");
  if ((await deriveRobotId(raw)) !== iss) throw new AssertionError("iss_key_mismatch");

  let ok = false;
  try {
    ok = await verifyJws(parsed, await importEd25519Public(raw));
  } catch {
    ok = false;
  }
  if (!ok) throw new AssertionError("bad_signature");

  if (c.aud !== o.aud) throw new AssertionError("bad_aud");
  if (c.htm !== o.method.toUpperCase()) throw new AssertionError("bad_htm");
  if (c.htu !== o.htu) throw new AssertionError("bad_htu");
  if (!isInt(c.iat) || !isInt(c.exp)) throw new AssertionError("bad_times");
  if (c.exp <= c.iat || c.exp - c.iat > 60) throw new AssertionError("bad_lifetime");
  if (c.iat > o.now + SKEW_SECONDS) throw new AssertionError("iat_in_future");
  if (c.exp + SKEW_SECONDS < o.now) throw new AssertionError("expired");
  if (typeof c.jti !== "string" || c.jti.length < 22 || c.jti.length > 128) throw new AssertionError("bad_jti");

  return { robotId: iss, jti: c.jti, exp: c.exp };
}
