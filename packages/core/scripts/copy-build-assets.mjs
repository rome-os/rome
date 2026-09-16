// Copy non-TypeScript runtime assets into dist/ after tsc.
//
// tsc emits only compiled TypeScript, but a few modules ship real files next to
// themselves and resolve them at runtime through import.meta.url — the WeChat
// reader's python helper and the vendored key tool. In `source` mode they are
// read straight from src/; in `compiled` mode src/ is deleted, so they must
// exist in dist/ at the same relative path. Keep this list in sync with any new
// sibling asset a module loads at runtime.

import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ASSETS = [
  "channels/wechat-user-helper.py",
  "channels/wechat-user-launch-driver.py",
  "channels/vendor/wcdb_key_tool.py",
];

for (const rel of ASSETS) {
  const from = join(pkgRoot, "src", rel);
  const to = join(pkgRoot, "dist", rel);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
  console.log(`copied ${rel}`);
}
