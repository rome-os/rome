import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { AppManifestData } from "@rome-os/app-runtime/packaging";
import type { AppOnDisk } from "./appModules.js";
import { devOnlyImports } from "./validate.js";

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

describe("devOnlyImports", () => {
  let root: string;
  let app: AppOnDisk;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rome-validate-test-"));
    write(
      root,
      "package.json",
      JSON.stringify({
        dependencies: { "drizzle-orm": "1" },
        devDependencies: { "@rstest/core": "1", vitest: "1" },
      }),
    );
    app = {
      appDir: root,
      builtRoot: join(root, "dist"),
      manifest: {
        id: "demo",
        version: "0.1.0",
        actions: ["actions/note"],
        // No entry: the host's default, api/index.
        api: {},
      } as AppManifestData,
      tablePrefix: "demo",
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("names a dev dependency the host-loaded code reaches, and nothing else", async () => {
    write(
      root,
      "dist/actions/note/index.js",
      'import { sql } from "drizzle-orm";\nimport { helper } from "../../lib/helper.js";\nimport fs from "node:fs";\n',
    );
    write(root, "dist/lib/helper.js", 'export const helper = await import("@rstest/core/x");\n');
    write(
      root,
      "dist/api/index.js",
      'import path from "path";\nimport { x } from "#internal/x";\nimport { vi } from "vitest";\n// data comes from "feishu"\nconst note = "see import(\\"vitest\\")";\nexport default {};\n',
    );
    // Not reachable from an action, hook or the API: the build's test helpers.
    write(root, "dist/test-only.js", 'import "vitest";\n');

    expect((await devOnlyImports(app)).missing.sort()).toEqual([
      "dist/api/index.js imports vitest",
      "dist/lib/helper.js imports @rstest/core",
    ]);
  });

  it("reports nothing scanned when the app has only TypeScript source", async () => {
    write(root, "dist/actions/note/index.ts", 'import { vi } from "vitest";\n');
    write(root, "dist/api/index.ts", "export default {};\n");

    expect(await devOnlyImports(app)).toEqual({ missing: [], scanned: 0 });
  });
});
