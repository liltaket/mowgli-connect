import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { b64urlEncode, deriveRobotId, signJws } from "../src/crypto";
import type { Env } from "../src/env";
import { createSession } from "../src/session";
import { nowSeconds, randomToken } from "../src/util";

export const ORIGIN = "https://relay.test";
export const testEnv = env as unknown as Env;

export async function call(path: string, init: RequestInit = {}, e: Env = testEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, init) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export interface TestRobot {
  privateKey: CryptoKey;
  publicKey: string;
  robotId: string;
}

export async function newRobot(): Promise<TestRobot> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { privateKey: pair.privateKey, publicKey: b64urlEncode(raw), robotId: await deriveRobotId(raw) };
}

export interface AssertionOverrides {
  method?: string;
  path?: string;
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signWith?: CryptoKey;
}

export async function assertion(robot: TestRobot, method: string, path: string, o: AssertionOverrides = {}): Promise<string> {
  const iat = nowSeconds();
  const claims = {
    iss: robot.robotId,
    aud: ORIGIN,
    htm: method,
    htu: `${ORIGIN}${path}`,
    iat,
    exp: iat + 60,
    jti: randomToken(16),
    ...o.claims,
  };
  const jws = await signJws({ alg: "EdDSA", typ: "mc-robot+jwt", ...o.header }, claims, o.signWith ?? robot.privateKey);
  return `MC-Robot ${jws}`;
}

export async function register(robot: TestRobot, name?: string, o: AssertionOverrides = {}): Promise<Response> {
  return call("/v1/robots/register", {
    method: "POST",
    headers: { Authorization: await assertion(robot, "POST", "/v1/robots/register", o), "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: robot.publicKey, ...(name !== undefined ? { name } : {}) }),
  });
}

export async function self(robot: TestRobot, o: AssertionOverrides = {}): Promise<Response> {
  return call("/v1/robots/self", { headers: { Authorization: await assertion(robot, "GET", "/v1/robots/self", o) } });
}

export interface TestUser {
  id: string;
  cookie: string;
}

let userCounter = 0;
export async function newUser(login?: string): Promise<TestUser> {
  const n = ++userCounter * 1000 + Math.floor(Math.random() * 999);
  const id = `gh:${n}`;
  const now = nowSeconds();
  await testEnv.DB.prepare("INSERT INTO users (id, login, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, login ?? `user${n}`, `User ${n}`, now, now)
    .run();
  const token = await createSession(testEnv, id);
  return { id, cookie: `__Host-mcr_session=${token}` };
}

export function post(
  path: string,
  user: TestUser | null,
  form: Record<string, string>,
  origin: string | null = ORIGIN,
  fetchSite?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (user) headers.Cookie = user.cookie;
  if (origin !== null) headers.Origin = origin;
  if (fetchSite) headers["Sec-Fetch-Site"] = fetchSite;
  return call(path, { method: "POST", headers, body: new URLSearchParams(form).toString(), redirect: "manual" });
}

export function get(path: string, user: TestUser | null): Promise<Response> {
  return call(path, { headers: user ? { Cookie: user.cookie } : {}, redirect: "manual" });
}

/** Register a robot and claim it for `user`. */
export async function registerAndClaim(user: TestUser, label?: string): Promise<{ robot: TestRobot; code: string }> {
  const robot = await newRobot();
  const reg = (await (await register(robot)).json()) as { pairingCode: string };
  const res = await post("/claim", user, { code: reg.pairingCode, ...(label ? { label } : {}) });
  if (res.status !== 303) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
  return { robot, code: reg.pairingCode };
}

export function decodeJws(token: string): { header: Record<string, unknown>; payload: Record<string, any> } {
  const [h, p] = token.split(".") as [string, string];
  const d = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  return { header: d(h), payload: d(p) };
}
