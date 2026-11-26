import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
        export { connectHost } from "@rome-os/node-core/host";
        export { discoverHelper } from "../rome-node-core/dist/computer-use/discovery.js";
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
      }): Promise<string>;
    };
    expect(typeof connectHost).toBe("function");
    const options = { platform: "darwin" as const, applications: [] };
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
