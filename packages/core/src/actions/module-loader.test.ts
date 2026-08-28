import { describe, expect, it } from "@rstest/core";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// These tests spawn a real Node process (with tsx, the same loader the dev
// stack and forked action workers run under). Rstest cannot host them: its
// module runner executes `import(url)` through vite-node, which resolves the
// module graph itself and never consults Node's resolve hooks — the very
// mechanism under test.
describe("importModuleWithCacheBuster env epoch (native ESM)", () => {
  const TEST_KEY = "MODULE_LOADER_EPOCH_PROBE";

  it("re-evaluates the relative-import graph only after an epoch bump", async () => {
    const dir = await mkdtemp(join(tmpdir(), "module-loader-epoch-"));
    try {
      // The env read lives in an imported helper, not the entry: the resolve
      // hook must propagate the entry's cache salt onto the relative import
      // or the helper stays cached across epochs.
      await writeFile(
        join(dir, "config.js"),
        `export const captured = process.env.${TEST_KEY} ?? "unset";\n`,
        "utf-8",
      );
      await writeFile(join(dir, "entry.js"), `export { captured } from "./config.js";\n`, "utf-8");

      const loaderUrl = pathToFileURL(
        resolve(dirname(fileURLToPath(import.meta.url)), "module-loader.ts"),
      ).href;
      const probePath = join(dir, "probe.mjs");
      await writeFile(
        probePath,
        `
import { bumpModuleEnvEpoch, importModuleWithCacheBuster } from ${JSON.stringify(loaderUrl)};

const entry = process.argv[2];
const before = await importModuleWithCacheBuster(entry);
process.env.${TEST_KEY} = "v1";
const withoutBump = await importModuleWithCacheBuster(entry);
bumpModuleEnvEpoch();
const after = await importModuleWithCacheBuster(entry);
console.log(JSON.stringify({
  before: before.captured,
  withoutBump: withoutBump.captured,
  after: after.captured,
}));
`,
        "utf-8",
      );

      // Run under tsx — both the `source` container mode and the forked action
      // workers in dev use it, and it is the loader that normalizes queries
      // away without the short-circuit hook. (Plain node, the `compiled` mode,
      // exercises the same hooks minus the tsx chain.)
      const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", probePath, join(dir, "entry.js")],
        { cwd: coreRoot },
      );
      const lines = stdout.trim().split("\n");
      expect(JSON.parse(lines[lines.length - 1])).toEqual({
        before: "unset",
        withoutBump: "unset",
        after: "v1",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
