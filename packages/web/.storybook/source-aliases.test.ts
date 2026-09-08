import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sourceAliases } from "./source-aliases.ts";

test("package exports resolve to TS, TSX, nested entries, and CSS sources", () => {
  const aliases = {
    ...sourceAliases(new URL("../../ui/", import.meta.url)),
    ...sourceAliases(new URL("../../web-content/", import.meta.url)),
  };
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
