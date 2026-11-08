import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(dir, "migrations"));
  // Throwaway relay signing key, regenerated on every run. Never a real credential.
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = (await webcrypto.subtle.exportKey("jwk", (pair as CryptoKeyPair).privateKey)) as JsonWebKey;

  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            RELAY_ORIGIN: "https://relay.test",
            RELAY_KEY_ID: "test-k1",
            RELAY_SIGNING_KEY: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d }),
            PROVISIONER: "fake",
            ROBOT_ZONE: "robots.test",
            GITHUB_CLIENT_ID: "test-client-id",
            GITHUB_CLIENT_SECRET: "test-client-secret",
            ALLOWED_GITHUB_LOGINS: "*", // tests: any user (empty would mean nobody)
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
