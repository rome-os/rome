import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { LibConfig } from "@rslib/core";
import { createBuildContext } from "./createRslibConfig.js";

const require = createRequire(import.meta.url);

test("the web bundle uses the SDK-owned React and renderer", async (t) => {
  const appDir = await mkdtemp(join(tmpdir(), "rome-react-aliases-"));
  t.after(() => rm(appDir, { recursive: true, force: true }));
  const webDir = join(appDir, "src", "web");
  await mkdir(webDir, { recursive: true });
  await writeFile(
    join(appDir, "app.yaml"),
    [
      "formatVersion: 1",
      "id: react-alias-test",
      "name: React alias test",
      "version: 0.1.0",
      "description: Test app",
      "appRoot: dist",
      "web:",
      "  displayName: Test",
      "  navLabel: Test",
      "",
    ].join("\n"),
  );
  await writeFile(join(webDir, "App.tsx"), "export default function App() { return null; }\n");

  const context = await createBuildContext({ cwd: appDir, mode: "production" });
  const [webLib] = context.rslibConfig.lib as LibConfig[];

  assert.deepEqual(webLib.resolve?.alias, {
    react: dirname(require.resolve("react/package.json")),
    "react-dom": dirname(require.resolve("react-dom/package.json")),
  });

  const generatedEntry = await readFile(join(appDir, "node_modules", ".rome", "main.tsx"), "utf8");
  assert.match(generatedEntry, /from "react";/);
  assert.match(generatedEntry, /from "react-dom\/client";/);
});
