// Build step 2 of 2. `tsc` emits only JavaScript, so the YAML and Markdown the
// manifest points at (agent definitions, `action.yaml`) would never reach
// `dist/` — and pack validation fails on a missing artifact file.

import { cpSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const COPIED_EXTENSIONS = new Set([".yaml", ".yml", ".md", ".json", ".svg"]);

cpSync(join(appDir, "src"), join(appDir, "dist"), {
  recursive: true,
  // The filter runs on directories too, and returning false for one prunes the
  // whole subtree — so every directory passes and only files are tested.
  filter: (source) => statSync(source).isDirectory() || COPIED_EXTENSIONS.has(extname(source)),
});
