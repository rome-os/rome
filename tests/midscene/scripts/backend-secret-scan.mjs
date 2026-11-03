#!/usr/bin/env node
// Fail when any file under the given directories contains a model secret.
// GitHub masks secrets in step logs but not in uploaded artifacts, so the
// backend workflow runs this before every upload. Values are never printed.
//
//   node scripts/backend-secret-scan.mjs <dir>...

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const secrets = [];
const modelEnvRaw =
  process.env.ROME_E2E_ANTHROPIC_ENV_JSON ??
  (process.env.ROME_E2E_ANTHROPIC_ENV_FILE && existsSync(process.env.ROME_E2E_ANTHROPIC_ENV_FILE)
    ? readFileSync(process.env.ROME_E2E_ANTHROPIC_ENV_FILE, "utf8")
    : undefined);
if (modelEnvRaw) {
  const parsed = JSON.parse(modelEnvRaw);
  const env = parsed.env ?? parsed;
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    if (env[key]) secrets.push({ name: key, value: env[key] });
  }
}
// Midscene's key comes from the environment in CI, or a dotenv file locally.
const dotenvPath = process.env.ROME_E2E_ENV_FILE;
const midsceneKey =
  process.env.MIDSCENE_MODEL_API_KEY ??
  (dotenvPath && existsSync(dotenvPath)
    ? readFileSync(dotenvPath, "utf8")
        .match(/^MIDSCENE_MODEL_API_KEY=(.*)$/m)?.[1]
        ?.trim()
        .replace(/^(["'])(.*)\1$/, "$2")
    : undefined);
if (midsceneKey) secrets.push({ name: "MIDSCENE_MODEL_API_KEY", value: midsceneKey });

const files = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });

let leaks = 0;
for (const path of process.argv.slice(2).flatMap(files)) {
  const content = readFileSync(path, "latin1");
  for (const { name, value } of secrets) {
    if (value.length >= 8 && content.includes(value)) {
      console.error(`secret ${name} found in ${path}`);
      leaks += 1;
    }
  }
}
console.log(`Secret scan: ${secrets.length} secret(s) checked, ${leaks} match(es).`);
process.exit(leaks ? 1 : 0);
