import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function execute(args: string[]) {
  const child = spawn(process.execPath, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
  return { child, done };
}

test(
  "refuses a competing build before it can alter the app bundle",
  {
    skip: process.platform !== "darwin" || process.env.ROME_COMPUTER_USE_BUILD_LOCK_TEST !== "1",
    timeout: 120_000,
  },
  async () => {
    await mkdir(join(repo, ".scratch"), { recursive: true });
    const directory = await mkdtemp(join(repo, ".scratch/build-lock-"));
    const alias = `${directory}-alias`;
    await symlink(directory, alias);
    const output = join(directory, "Rome Computer Use.app");
    const aliasedOutput = join(alias, "Rome Computer Use.app");
    const args = [
      "packages/rome-node-core/scripts/build-computer-use.ts",
      "--output",
      output,
      "--unsigned",
    ];
    const aliasedArgs = [
      "packages/rome-node-core/scripts/build-computer-use.ts",
      "--output",
      aliasedOutput,
      "--unsigned",
    ];
    const first = execute([...args, "--build-number", "43.1"]);
    const second = execute([...aliasedArgs, "--build-number", "43.2"]);
    try {
      const results = await Promise.all([
        first.done.then((result) => ({ build: "43.1", ...result })),
        second.done.then((result) => ({ build: "43.2", ...result })),
      ]);
      const winners = results.filter((result) => result.code === 0);
      const losers = results.filter((result) => result.code !== 0);
      assert.equal(winners.length, 1, `Expected one winner: ${JSON.stringify(results)}`);
      assert.equal(losers.length, 1, `Expected one locked loser: ${JSON.stringify(results)}`);
      assert.match(losers[0].stderr, /Computer-use build output is locked/);
      const info = await readFile(join(output, "Contents/Info.plist"), "utf8");
      assert.match(
        info,
        new RegExp(
          `<key>CFBundleVersion</key><string>${winners[0].build.replace(".", "\\.")}</string>`,
        ),
      );
      const next = await execute([...args, "--build-number", "43.3"]).done;
      assert.equal(next.code, 0, next.stderr);
      const updatedInfo = await readFile(join(output, "Contents/Info.plist"), "utf8");
      assert.match(updatedInfo, /<key>CFBundleVersion<\/key><string>43\.3<\/string>/);
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGTERM");
      if (second.child.exitCode === null) second.child.kill("SIGTERM");
      await Promise.allSettled([first.done, second.done]);
      await rm(alias, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
