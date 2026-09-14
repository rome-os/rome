import assert from "node:assert/strict";
import { test } from "@rstest/core";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sourceAliases } from "./source-aliases.js";

test("package exports resolve to TS, TSX, nested entries, and CSS sources", () => {
  const aliases: Record<string, string> = {};
  for (const directory of ["../../ui/", "../../web-content/"]) {
    const root = new URL(directory, import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const generated = sourceAliases(root);
    assert.deepEqual(
      Object.keys(generated),
      Object.keys(manifest.exports).map((subpath) => `${manifest.name}${subpath.slice(1)}$`),
    );
    for (const source of Object.values(generated)) assert.ok(existsSync(source), source);
    Object.assign(aliases, generated);
  }
  for (const [specifier, path] of Object.entries({
    "@rome-os/ui$": "../../ui/src/index.ts",
    "@rome-os/ui/button$": "../../ui/src/button.tsx",
    "@rome-os/ui/styles.css$": "../../ui/src/styles.css",
    "@rome-os/rome-web-components$": "../../web-content/src/index.tsx",
    "@rome-os/rome-web-components/news-item/schema$": "../../web-content/src/news-item/schema.ts",
    "@rome-os/rome-web-components/styles$": "../../web-content/styles.css",
    "@rome-os/rome-web-components/styles.css$": "../../web-content/styles.css",
  })) {
    assert.equal(aliases[specifier], fileURLToPath(new URL(path, import.meta.url)));
  }
});
