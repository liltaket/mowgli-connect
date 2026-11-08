import { b64urlEncode } from "./crypto";

export const SKEW_SECONDS = 30;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}

export function isRobotId(s: string): boolean {
  return /^[a-z2-7]{16}$/.test(s);
}

/** Only same-origin absolute paths; blocks `//host`, `/\host` and control chars. */
export function safeReturnPath(p: string | null | undefined): string {
  if (!p || !p.startsWith("/") || p.startsWith("//") || /[\\\u0000-\u001f]/.test(p)) return "/";
  return p;
}

export function cleanLabel(s: unknown, max = 64): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!t) return null;
  return t.slice(0, max);
}

/** Reads a request body as UTF-8 text, refusing anything larger than `max` bytes. */
export async function readBodyText(request: Request, max: number): Promise<string | null> {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > max) return null;
  return new TextDecoder().decode(buf);
}
