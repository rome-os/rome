import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { LibConfig } from "@rslib/core";
import { createBuildContext, resolveSdkReactAliases } from "./createRslibConfig.js";

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

test("a mismatched SDK-owned React pair fails before bundling", async (t) => {
  const packageDir = await mkdtemp(join(tmpdir(), "rome-mismatched-react-"));
  t.after(() => rm(packageDir, { recursive: true, force: true }));
  const reactPackage = join(packageDir, "react.json");
  const reactDomPackage = join(packageDir, "react-dom.json");
  await writeFile(reactPackage, JSON.stringify({ name: "react", version: "19.1.0" }));
  await writeFile(reactDomPackage, JSON.stringify({ name: "react-dom", version: "19.2.8" }));

  assert.throws(
    () =>
      resolveSdkReactAliases((specifier) =>
        specifier === "react/package.json" ? reactPackage : reactDomPackage,
      ),
    /must resolve matching React packages, found react@19\.1\.0 and react-dom@19\.2\.8/,
  );
});
