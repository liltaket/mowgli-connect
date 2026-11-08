#!/usr/bin/env node
// Generates an Ed25519 relay signing key pair locally. Nothing is uploaded.
//
//   node scripts/gen-key.mjs [--kid k1] [--out relay-key.k1.json]
//
// Without --out the private JWK is printed to stdout (one line) so it can be piped:
//   node scripts/gen-key.mjs --kid k1 | tail -1 | wrangler secret put RELAY_SIGNING_KEY
// Human-readable info goes to stderr.
import { webcrypto } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const kid = opt("--kid", "k1");
const out = opt("--out", null);

const { subtle } = webcrypto;
const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = await subtle.exportKey("jwk", pair.privateKey);
const privateJwk = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d });
const publicKey = jwk.x; // raw 32-byte public key, base64url (what /v1/robots/self publishes)

console.error(`kid:            ${kid}   (set as RELAY_KEY_ID)`);
console.error(`public key:     ${publicKey}   (published as relayKeys[0].publicKey)`);
console.error("private key:    secret RELAY_SIGNING_KEY (Ed25519 JWK). Keep it out of git.");

if (out) {
  if (existsSync(out)) {
    console.error(`refusing to overwrite ${out}`);
    process.exit(1);
  }
  writeFileSync(out, privateJwk + "\n", { mode: 0o600 });
  console.error(`wrote ${out} (mode 600). Upload with: wrangler secret put RELAY_SIGNING_KEY < ${out}`);
} else {
  console.log(privateJwk);
}
