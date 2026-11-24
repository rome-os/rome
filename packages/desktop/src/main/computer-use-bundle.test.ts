import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { build } from "esbuild";

const packageDir = join(__dirname, "..", "..");

async function loadBundledCjs(contents: string): Promise<Record<string, unknown>> {
  const result = await build({
    stdin: { contents, resolveDir: packageDir, loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  const dir = mkdtempSync(join(tmpdir(), "rome-desktop-cjs-bundle-"));
  const file = join(dir, "bundle.cjs");
  try {
    writeFileSync(file, result.outputFiles[0].text, "utf8");
    return createRequire(__filename)(file) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Desktop CJS bundle compatibility with @rome-os/node-core", () => {
  it("loads @rome-os/node-core/computer-use in esbuild CJS output without throwing", async () => {
    const mod = (await loadBundledCjs(
      'export { createComputerUseHost } from "@rome-os/node-core/computer-use";',
    )) as {
      createComputerUseHost: (options?: {
        bundledAppPath?: string;
        platform?: NodeJS.Platform;
        stateDir?: string;
      }) => { describe(): Promise<Record<string, unknown>> };
    };

    const dir = mkdtempSync(join(tmpdir(), "rome-desktop-cu-state-"));
    const appDir = join(dir, "Rome Computer Use.app");
    mkdirSync(appDir);
    try {
      const configured = await mod
        .createComputerUseHost({
          bundledAppPath: appDir,
          platform: "darwin",
          stateDir: dir,
        })
        .describe();
      expect(configured.prefix).toBe("computer");
      expect(configured.configured).toBe(process.arch === "arm64");

      const missing = await mod
        .createComputerUseHost({
          bundledAppPath: join(dir, "Missing.app"),
          platform: "darwin",
          stateDir: dir,
        })
        .describe();
      expect(missing.prefix).toBe("computer");
      expect(missing.configured).toBe(false);

      // Even without bundledAppPath, CJS empty import.meta must not throw.
      const fallback = await mod
        .createComputerUseHost({
          platform: "darwin",
          stateDir: dir,
        })
        .describe();
      expect(fallback.prefix).toBe("computer");
      expect(typeof fallback.configured).toBe("boolean");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads @rome-os/node-core/host in esbuild CJS output without throwing", async () => {
    const mod = await loadBundledCjs('export * from "@rome-os/node-core/host";');
    expect(typeof mod.AuditStore).toBe("function");
  });
});
