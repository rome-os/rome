import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@rstest/core";
import { build } from "esbuild";

it("loads the Node host and discovers its helper from an Electron CJS bundle", async () => {
  const packageDir = join(__dirname, "..", "..");
  const result = await build({
    stdin: {
      contents: `
        export { connectHost, discoverHelper } from "@rome-os/node-core/host";
      `,
      resolveDir: packageDir,
    },
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    minify: true,
    write: false,
    logOverride: { "empty-import-meta": "silent" },
  });
  const dir = mkdtempSync(join(tmpdir(), "rome-desktop-cjs-"));
  try {
    const bundle = join(dir, "bundle.cjs");
    writeFileSync(bundle, result.outputFiles[0].text);
    const { connectHost, discoverHelper } = createRequire(__filename)(bundle) as {
      connectHost: unknown;
      discoverHelper(options: {
        platform: "darwin";
        applications: string[];
        bundledAppPath?: string;
        stagedAppPath?: string | null;
      }): Promise<string>;
    };
    expect(typeof connectHost).toBe("function");
    const options = { platform: "darwin" as const, applications: [], stagedAppPath: null };
    const helper = join(dir, "Rome Computer Use.app");
    mkdirSync(helper);
    await expect(discoverHelper({ ...options, bundledAppPath: helper })).resolves.toBe(helper);
    await expect(discoverHelper(options)).rejects.toMatchObject({
      code: "computer_use_helper_missing",
    });
    await expect(
      discoverHelper({
        ...options,
        bundledAppPath: join(dir, "missing"),
        applications: [join(dir, "absent"), dir],
      }),
    ).resolves.toBe(helper);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("checks read and execute permissions for every account throughout the helper template", () => {
  const { checkTemplatePermissions } = createRequire(__filename)(
    "../../scripts/check-computer-use.mjs",
  ) as {
    checkTemplatePermissions(path: string): void;
  };
  const root = mkdtempSync(join(tmpdir(), "rome-cu-permissions-"));
  try {
    const contents = join(root, "Contents");
    const macOS = join(contents, "MacOS");
    const executable = join(macOS, "RomeComputerUse");
    const plist = join(contents, "Info.plist");
    mkdirSync(macOS, { recursive: true });
    for (const dir of [root, contents, macOS]) chmodSync(dir, 0o755);
    writeFileSync(executable, "");
    chmodSync(executable, 0o755);
    writeFileSync(plist, "");
    chmodSync(plist, 0o644);
    expect(() => checkTemplatePermissions(root)).not.toThrow();
    for (const [path, mode, required] of [
      [contents, 0o705, "rx"],
      [executable, 0o744, "rx"],
      [executable, 0o644, "rx"],
      [plist, 0o744, "rx"],
      [plist, 0o654, "rx"],
      [plist, 0o604, "r"],
    ] as const) {
      chmodSync(path, mode);
      expect(() => checkTemplatePermissions(root)).toThrow(`requires a+${required}: ${path}`);
      chmodSync(path, path === plist ? 0o644 : 0o755);
    }
    symlinkSync(plist, join(contents, "link"));
    expect(() => checkTemplatePermissions(root)).toThrow("Expected a regular file or directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
