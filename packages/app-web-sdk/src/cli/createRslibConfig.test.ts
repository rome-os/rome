import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LibConfig } from "@rslib/core";
import { expect, it } from "@rstest/core";
import { createBuildContext, resolveSdkReactAliases } from "./createRslibConfig.js";

const require = createRequire(import.meta.url);

it("uses the SDK-owned React and renderer for the web bundle", async () => {
  const appDir = await mkdtemp(join(tmpdir(), "rome-react-aliases-"));
  try {
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

    expect(webLib.resolve?.alias).toEqual({
      react: dirname(require.resolve("react/package.json")),
      "react-dom": dirname(require.resolve("react-dom/package.json")),
    });

    const generatedEntry = await readFile(
      join(appDir, "node_modules", ".rome", "main.tsx"),
      "utf8",
    );
    expect(generatedEntry).toMatch(/from "react";/);
    expect(generatedEntry).toMatch(/from "react-dom\/client";/);
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});

it("fails before bundling a mismatched SDK-owned React pair", async () => {
  const packageDir = await mkdtemp(join(tmpdir(), "rome-mismatched-react-"));
  try {
    const reactPackage = join(packageDir, "react.json");
    const reactDomPackage = join(packageDir, "react-dom.json");
    await writeFile(reactPackage, JSON.stringify({ name: "react", version: "19.1.0" }));
    await writeFile(reactDomPackage, JSON.stringify({ name: "react-dom", version: "19.2.8" }));

    expect(() =>
      resolveSdkReactAliases((specifier) =>
        specifier === "react/package.json" ? reactPackage : reactDomPackage,
      ),
    ).toThrow(/must resolve matching React packages, found react@19\.1\.0 and react-dom@19\.2\.8/);
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});
