/**
 * pnpm sts:keygen — ключі runtime-STS (ES256).
 *  .secrets/runtime-sts.private.jwk.json — приватний, лише для runtime (права 600, у git не йде);
 *  .secrets/runtime-sts.jwks.json        — публічний JWKS для MCP-серверів.
 * Приватний ключ у термінал НЕ друкуємо. Існуючі ключі не перезаписуємо без --force (ротація — свідома дія).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

const dir = join(import.meta.dirname, "..", ".secrets");
const privPath = join(dir, "runtime-sts.private.jwk.json");
const pubPath = join(dir, "runtime-sts.jwks.json");
if (existsSync(privPath) && !process.argv.includes("--force")) {
  console.error(`Ключ уже є: ${privPath}. Ротація: pnpm sts:keygen --force (і перезапусти сервери).`);
  process.exit(1);
}
const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const pub = await exportJWK(publicKey);
const kid = await calculateJwkThumbprint(pub);
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(privPath, JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: "ES256" }), { mode: 0o600 });
writeFileSync(pubPath, JSON.stringify({ keys: [{ ...pub, kid, alg: "ES256", use: "sig" }] }, null, 2));
console.log(`OK: kid=${kid}\n  приватний: ${privPath} (600)\n  публічний: ${pubPath}`);
