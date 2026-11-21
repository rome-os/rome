import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const app = process.env.ROME_COMPUTER_USE_TEST_APP;

const options = {
  skip: process.platform !== "darwin" || !app,
  timeout: 20_000,
};
test("staged app installation", options, async () => {
  const state = await realpath(await mkdtemp(join(tmpdir(), "rome-native-install-")));
  await chmod(state, 0o700);
  try {
    const stage = async (name: string) => {
      const directory = join(state, `.staging-${name}`);
      await mkdir(directory, { mode: 0o700 });
      const path = join(directory, "Rome Computer Use.app");
      await cp(app!, path, { recursive: true });
      await writeFile(join(path, "Contents/Resources/stage-marker.txt"), name, "utf8");
      return join(path, "Contents/MacOS/RomeComputerUse");
    };
    const first = await stage("first");
    const installed = JSON.parse(
      (await execute(first, ["--install-staged-app", "--state-dir", state])).stdout,
    );
    assert.equal(installed.ok, true);
    assert.equal(installed.path, join(state, "Rome Computer Use.app"));
    await assert.rejects(lstat(first));

    const second = await stage("second");
    const holder = spawn(
      "python3",
      [
        "-c",
        "import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()",
        join(state, "helper.lock"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      const [ready] = await once(holder.stdout, "data");
      assert.match(ready.toString(), /locked/);
      await assert.rejects(
        execute(second, ["--install-staged-app", "--state-dir", state]),
        (error: unknown) => {
          assert.match(
            String((error as { stderr: string }).stderr),
            /helper_running_install_refused/,
          );
          return true;
        },
      );
      assert.equal((await lstat(second)).isFile(), true);
    } finally {
      holder.stdin.end();
      await once(holder, "exit");
    }
    const replaced = JSON.parse(
      (await execute(second, ["--install-staged-app", "--state-dir", state])).stdout,
    );
    assert.equal(replaced.path, installed.path);
    assert.equal(replaced.previousPath, join(state, ".staging-second", "Rome Computer Use.app"));
    assert.equal((await lstat(replaced.previousPath)).isDirectory(), true);
    assert.equal(
      await readFile(join(replaced.previousPath, "Contents/Resources/stage-marker.txt"), "utf8"),
      "first",
    );
    assert.equal(
      await readFile(join(installed.path, "Contents/Resources/stage-marker.txt"), "utf8"),
      "second",
    );
    const entries = await readdir(state);
    assert.equal(
      entries.some((entry) => entry.startsWith(".previous-app-")),
      false,
      `Atomic swap must not leak orphaned .previous-app-* backups: ${JSON.stringify(entries)}`,
    );

    const unsafe = await stage("unsafe");
    await chmod(state, 0o755);
    try {
      await assert.rejects(
        execute(unsafe, ["--install-staged-app", "--state-dir", state]),
        (error: unknown) => {
          assert.match(String((error as { stderr: string }).stderr), /unsafe_install_directory/);
          return true;
        },
      );
    } finally {
      await chmod(state, 0o700);
    }

    const retained = join(state, ".retained-app");
    await rename(installed.path, retained);
    await symlink(retained, installed.path);
    await assert.rejects(
      execute(unsafe, ["--install-staged-app", "--state-dir", state]),
      (error: unknown) => {
        assert.match(String((error as { stderr: string }).stderr), /unsafe_install_directory/);
        return true;
      },
    );
    assert.equal((await lstat(installed.path)).isSymbolicLink(), true);
    assert.equal((await lstat(retained)).isDirectory(), true);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
