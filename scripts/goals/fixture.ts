// Temporary repository trees for the goals tests.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Writes `files`, keyed by repo-root path, into a new temporary folder and returns its path. */
export function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "goals-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
