import { b64urlEncode, deriveRobotId, importEd25519Public, JwsError, parseJws, verifyJws } from "./crypto";
import { SKEW_SECONDS } from "./util";

/**
 * Delegations (docs/agent-delegation.md). A delegate is an Ed25519 key held by an AI agent or an
 * automation; its id is derived from the key like a robot id, and every call is a short-lived
 * assertion signed with it, bound to the method, the URL and a hash of the body. There is no
 * bearer token to steal.
 */

export class DelegateAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export const DELEGATE_ID = /^[a-z2-7]{16}$/;

/** Same derivation as robot ids: base32lower(SHA-256(rawPublicKey)[0..10)). */
export const deriveDelegateId = deriveRobotId;

/** "abcdefghijklmnop" -> "abcd-efgh-ijkl-mnop", as the CLI prints it. */
export function fingerprint(id: string): string {
  return id.match(/.{1,4}/g)!.join("-");
}

export async function bodyHash(body: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))));
}

export interface VerifiedDelegateAssertion {
  delegateId: string;
  jti: string;
  exp: number;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Verifies `Authorization: MC-Delegate <jws>` for a request whose body is `body`. `resolveKey`
 * returns the raw public key for an issuer (null if unknown). Does NOT consume the jti.
 */
export async function verifyDelegateAssertion(o: {
  authorization: string | null;
  method: string;
  htu: string;
  aud: string;
  body: string;
  now: number;
  resolveKey: (iss: string) => Promise<Uint8Array | null>;
}): Promise<VerifiedDelegateAssertion> {
  const m = /^MC-Delegate ([^\s]+)$/.exec(o.authorization ?? "");
  if (!m) throw new DelegateAuthError("missing_assertion");
  let parsed;
  try {
    parsed = parseJws(m[1]!);
  } catch (e) {
    throw new DelegateAuthError(e instanceof JwsError ? "malformed" : "malformed");
  }
  if (parsed.header.alg !== "EdDSA" || parsed.header.typ !== "mc-delegate+jwt") throw new DelegateAuthError("bad_header");
  const c = parsed.payload;
  if (typeof c.iss !== "string" || !DELEGATE_ID.test(c.iss)) throw new DelegateAuthError("bad_iss");
  const raw = await o.resolveKey(c.iss);
  if (!raw) throw new DelegateAuthError("unknown_delegate");
  if ((await deriveDelegateId(raw)) !== c.iss) throw new DelegateAuthError("iss_key_mismatch");
  let ok = false;
  try {
    ok = await verifyJws(parsed, await importEd25519Public(raw));
  } catch {
    ok = false;
  }
  if (!ok) throw new DelegateAuthError("bad_signature");
  if (c.aud !== o.aud) throw new DelegateAuthError("bad_aud");
  if (c.htm !== o.method.toUpperCase()) throw new DelegateAuthError("bad_htm");
  if (c.htu !== o.htu) throw new DelegateAuthError("bad_htu");
  if (c.bdh !== (await bodyHash(o.body))) throw new DelegateAuthError("bad_bdh");
  if (!isInt(c.iat) || !isInt(c.exp)) throw new DelegateAuthError("bad_times");
  if (c.exp <= c.iat || c.exp - c.iat > 60) throw new DelegateAuthError("bad_lifetime");
  if (c.iat > o.now + SKEW_SECONDS) throw new DelegateAuthError("iat_in_future");
  if (c.exp + SKEW_SECONDS < o.now) throw new DelegateAuthError("expired");
  if (typeof c.jti !== "string" || c.jti.length < 22 || c.jti.length > 128) throw new DelegateAuthError("bad_jti");
  return { delegateId: c.iss, jti: c.jti, exp: c.exp };
}
