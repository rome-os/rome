import { execFile as nodeExecFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  APP_NAME,
  findInstalledHelper,
  launchPermissionSetup,
  RELEASE_SIGNING_REQUIREMENT,
  stagedHelperPath,
} from "@rome-os/node-core/host";
import { afterEach, beforeEach, expect, it, rs } from "@rstest/core";
import { shell } from "electron";
import * as hostApi from "@rome-os/node-core/host" with { rstest: "importActual" };
import { createComputerUseSettings } from "./computer-use-settings";
import { createStagedComputerUseHelper, stageComputerUseHelper } from "./computer-use-staging";
import { darwinStagingFiles, type StagingFiles } from "./computer-use-staging-fs";

rs.mock("electron", () => ({ shell: { openExternal: rs.fn(), showItemInFolder: rs.fn() } }));
rs.mock("@rome-os/node-core/host", () => ({ ...hostApi, launchPermissionSetup: rs.fn() }));

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const commandOptions = { timeout: 15_000, killSignal: "SIGKILL", encoding: "utf8" } as const;
const verifyArgs = ["--verify", "--deep", "--strict", `-R=${RELEASE_SIGNING_REQUIREMENT}`];
const binary = "Contents/MacOS/RomeComputerUse";
const plist = "Contents/Info.plist";
const icon = "Contents/Resources/icon.icns";
const hash = "a".repeat(40);
const version = { CFBundleVersion: "1", CFBundleShortVersionString: "1.0" };
let home: string;
let templatePath: string;
let stagedPath: string;
let parent: string;

async function bundle(path: string) {
  await fs.mkdir(join(path, "Contents/MacOS"), { recursive: true, mode: 0o700 });
  await fs.mkdir(join(path, "Contents/Resources"), { mode: 0o700 });
  await fs.writeFile(join(path, binary), hash, { mode: 0o700 });
  await fs.writeFile(join(path, icon), "icon", { mode: 0o600 });
  await fs.writeFile(join(path, plist), JSON.stringify(version), { mode: 0o600 });
}

// Linux CI uses /proc/self/fd to exercise the same pinned-directory contract.
const procPath = (fd: number, name = ".") => join("/proc/self/fd", String(fd), name);
const linuxTestFiles: StagingFiles = {
  openAt: (fd, name, flags, mode) => openSync(procPath(fd, name), flags, mode),
  statAt(fd, name) {
    const stat = lstatSync(procPath(fd, name), { bigint: true, throwIfNoEntry: false });
    return stat && { dev: stat.dev, ino: stat.ino, mode: Number(stat.mode), uid: Number(stat.uid) };
  },
  unlinkAt(fd, name, directory) {
    (directory ? rmdirSync : unlinkSync)(procPath(fd, name));
  },
  names: (fd) => readdirSync(procPath(fd)),
  publish(sourceDirFd, source, destDirFd, destination, replace) {
    const from = procPath(sourceDirFd, source);
    const to = procPath(destDirFd, destination);
    if (replace) renameSync(to, procPath(sourceDirFd, "previous"));
    else if (lstatSync(to, { throwIfNoEntry: false })) throw new Error("destination exists");
    renameSync(from, to);
  },
};

function fixture() {
  const log = { warn: rs.fn(), error: rs.fn() };
  const execFile = rs.fn(async (tool: string, args: string[]) => {
    const path = args.at(-1)!;
    if (tool === "/usr/bin/ditto") await fs.cp(args[0], path, { recursive: true });
    else if (tool === "/usr/bin/codesign") {
      const signature = await fs.readFile(join(path, binary), "utf8");
      if (args[0] === "--display") {
        expect(args.slice(0, -1)).toEqual(["--display", "--verbose=3"]);
        return { stdout: "", stderr: `CDHash=${signature}\n` };
      }
      expect(args.slice(0, -1)).toEqual(verifyArgs);
      if (signature === "unsigned") throw new Error("invalid signature");
    } else if (tool === "/usr/bin/plutil") {
      expect(args.slice(0, -1)).toEqual(["-convert", "json", "-o", "-"]);
      return { stdout: await fs.readFile(path, "utf8"), stderr: "" };
    } else expect(tool).toBe(lsregister);
    return { stdout: "", stderr: "" };
  });
  return {
    templatePath,
    homeDir: home,
    platform: "darwin" as const,
    stagingFiles: process.platform === "darwin" ? darwinStagingFiles() : linuxTestFiles,
    execFile,
    log,
  };
}

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "rome-cu-stage-"));
  templatePath = join(home, "Rome.app/Contents/Resources/native", APP_NAME);
  stagedPath = stagedHelperPath(home);
  parent = dirname(stagedPath);
  await bundle(templatePath);
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

it("installs once, repairs modes even on a cache hit, and registers the external copy both times", async () => {
  const options = fixture();
  const rome = dirname(parent);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const token = join(rome, "store-token.json");
  await fs.writeFile(token, "private", { mode: 0o600 });
  await fs.mkdir(join(parent, ".Rome Computer Use.staging-stale"));
  await fs.mkdir(join(parent, ".Rome Computer Use.old-stale"));
  await fs.mkdir(join(parent, "unrelated"));
  const publish = rs.fn<StagingFiles["publish"]>((sourceFd, source, destFd, dest, replace) => {
    const copy = options.execFile.mock.calls.find(([tool]) => tool === "/usr/bin/ditto")![1][1];
    expect(fstatSync(sourceFd).ino).toBe(lstatSync(dirname(copy)).ino);
    expect(fstatSync(destFd).ino).toBe(lstatSync(parent).ino);
    options.stagingFiles.publish(sourceFd, source, destFd, dest, replace);
  });
  const install = { ...options, stagingFiles: { ...options.stagingFiles, publish } };
  const calls = options.execFile.mock.calls;
  await expect(
    Promise.all([stageComputerUseHelper(install), stageComputerUseHelper(install)]),
  ).resolves.toEqual([true, true]);
  const original = await fs.stat(stagedPath);
  await fs.chmod(stagedPath, 0o700);
  await fs.chmod(join(stagedPath, icon), 0o600);
  await expect(stageComputerUseHelper(options)).resolves.toBe(true);
  expect((await fs.stat(stagedPath)).ino).toBe(original.ino);
  const copies = calls.filter(([tool]) => tool === "/usr/bin/ditto");
  expect(copies).toHaveLength(1);
  const copy = copies[0][1][1];
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(
    expect.any(Number),
    APP_NAME,
    expect.any(Number),
    APP_NAME,
    false,
  );
  expect(options.execFile).toHaveBeenCalledWith("/usr/bin/ditto", [templatePath, copy], {
    ...commandOptions,
    timeout: 30_000,
  });
  expect(dirname(dirname(copy))).toBe(parent);
  expect(
    calls
      .filter(([tool, args]) => tool === "/usr/bin/codesign" && args[0] === "--verify")
      .map(([, args]) => args.at(-1)),
  ).toEqual([templatePath, copy, templatePath, stagedPath]);
  expect(calls.filter(([tool]) => tool === lsregister).map(([, args]) => args)).toEqual([
    ["-u", templatePath],
    ["-f", stagedPath],
    ["-u", templatePath],
    ["-f", stagedPath],
  ]);
  for (const path of [
    rome,
    parent,
    stagedPath,
    ...["Contents", "Contents/MacOS", "Contents/Resources"].map((dir) => join(stagedPath, dir)),
  ]) {
    expect((await fs.stat(path)).mode & 0o777).toBe(0o755);
  }
  for (const path of [plist, icon])
    expect((await fs.stat(join(stagedPath, path))).mode & 0o777).toBe(0o644);
  expect((await fs.stat(token)).mode & 0o777).toBe(0o600);
  expect((await fs.readdir(parent)).sort()).toEqual([APP_NAME, "unrelated"]);
});

it("protects private siblings before opening the Rome root to other users", async () => {
  const root = dirname(parent);
  const database = join(root, "rome.db");
  const profile = join(root, "profile");
  const token = join(root, "store-token.json");
  const outside = join(home, "outside");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.writeFile(database, "db");
  await fs.chmod(database, 0o644);
  await fs.mkdir(profile);
  await fs.chmod(profile, 0o755);
  await fs.writeFile(token, "secret", { mode: 0o600 });
  await fs.writeFile(outside, "public");
  await fs.chmod(outside, 0o644);
  await fs.symlink(outside, join(root, "link"));
  const mode = (path: string) => lstatSync(path).mode & 0o777;
  const open: typeof fs.open = async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    if (path === root) {
      const chmod = handle.chmod.bind(handle);
      rs.spyOn(handle, "chmod").mockImplementation((value) => {
        expect([root, database, profile, token, outside].map(mode)).toEqual([
          0o700, 0o600, 0o700, 0o600, 0o644,
        ]);
        return chmod(value);
      });
    }
    return handle;
  };
  const options = fixture();
  expect(await stageComputerUseHelper({ ...options, fs: { ...fs, open } })).toBe(true);
  expect([root, parent, stagedPath].map(mode)).toEqual([0o755, 0o755, 0o755]);
  await fs.chmod(database, 0o644);
  expect(await stageComputerUseHelper(options)).toBe(true);
  expect(mode(database)).toBe(0o644);
});

it("keeps the Rome root private when a sibling cannot be secured", async () => {
  const root = dirname(parent);
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(join(root, "rome.db"), "db");
  await fs.chmod(join(root, "rome.db"), 0o644);
  const options = fixture();
  const openAt: StagingFiles["openAt"] = (fd, name, ...args) => {
    if (name === "rome.db") throw new Error("cannot open database");
    return options.stagingFiles.openAt(fd, name, ...args);
  };
  expect(
    await stageComputerUseHelper({ ...options, stagingFiles: { ...options.stagingFiles, openAt } }),
  ).toBe(false);
  expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining("cannot open database"));
  expect(options.execFile).not.toHaveBeenCalled();
});

it("keeps the Rome root private when a readable sibling belongs to another user", async () => {
  const root = dirname(parent);
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(join(root, "rome.db"), "db");
  await fs.chmod(join(root, "rome.db"), 0o644);
  const options = fixture();
  const statAt: StagingFiles["statAt"] = (fd, name) => {
    const entry = options.stagingFiles.statAt(fd, name);
    return name === "rome.db" && entry ? { ...entry, uid: entry.uid + 1 } : entry;
  };
  expect(
    await stageComputerUseHelper({ ...options, stagingFiles: { ...options.stagingFiles, statAt } }),
  ).toBe(false);
  expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
  expect(options.log.error).toHaveBeenCalledWith(
    expect.stringContaining("Cannot protect private entry"),
  );
  expect(options.execFile).not.toHaveBeenCalled();
});

it("replaces a matching staged helper when its internal entry cannot be repaired in place", async () => {
  await bundle(stagedPath);
  const beforeInode = (await fs.lstat(stagedPath)).ino;
  const options = fixture();
  const publish = rs.fn(options.stagingFiles.publish);
  const open: typeof fs.open = async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    if (path === join(stagedPath, plist)) {
      const stat = handle.stat.bind(handle);
      rs.spyOn(handle, "stat").mockImplementation((async () => {
        const info = await stat();
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
          uid: info.uid + 1,
        });
      }) as typeof handle.stat);
    }
    return handle;
  };
  expect(
    await stageComputerUseHelper({
      ...options,
      fs: { ...fs, open },
      stagingFiles: { ...options.stagingFiles, publish },
    }),
  ).toBe(true);
  expect(publish).toHaveBeenCalledWith(
    expect.any(Number),
    APP_NAME,
    expect.any(Number),
    APP_NAME,
    true,
  );
  expect((await fs.lstat(stagedPath)).ino).not.toBe(beforeInode);
});

it("still registers the published helper if cleaning up the swapped-out copy fails", async () => {
  await bundle(stagedPath);
  await fs.writeFile(join(stagedPath, binary), "b".repeat(40));
  const options = fixture();
  const unlinkAt: StagingFiles["unlinkAt"] = (fd, name, directory) => {
    if (name === "Contents" && directory) throw new Error("cleanup failed");
    options.stagingFiles.unlinkAt(fd, name, directory);
  };
  expect(
    await stageComputerUseHelper({
      ...options,
      stagingFiles: { ...options.stagingFiles, unlinkAt },
    }),
  ).toBe(true);
  expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(hash);
  expect(options.execFile).toHaveBeenCalledWith(lsregister, ["-f", stagedPath], expect.any(Object));
  expect(options.log.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
});

it.each([
  "cdhash",
  "CFBundleVersion",
  "CFBundleShortVersionString",
  "signature",
])("replaces a staged helper with a different %s", async (field) => {
  await bundle(stagedPath);
  if (field === "cdhash" || field === "signature") {
    await fs.writeFile(
      join(stagedPath, binary),
      field === "signature" ? "unsigned" : "b".repeat(40),
    );
  } else await fs.writeFile(join(stagedPath, plist), JSON.stringify({ ...version, [field]: "2" }));
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(true);
  expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(hash);
  expect(JSON.parse(await fs.readFile(join(stagedPath, plist), "utf8"))).toEqual(version);
  expect(await fs.readdir(parent)).toEqual([APP_NAME]);
});

it.each([
  "signature",
  "missing hash",
  "version",
  "missing executable",
])("rejects a template with invalid %s before copying", async (fault) => {
  if (fault === "version") await fs.writeFile(join(templatePath, plist), "{}");
  else if (fault === "missing executable") await fs.unlink(join(templatePath, binary));
  else await fs.writeFile(join(templatePath, binary), fault === "signature" ? "unsigned" : "bad");
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(false);
  expect(options.log.error).toHaveBeenCalled();
  expect(
    options.execFile.mock.calls.some(([tool]) => tool === "/usr/bin/ditto" || tool === lsregister),
  ).toBe(false);
  expect(await fs.readdir(parent)).toEqual([]);
});

it.each([
  ".rome",
  "computer-use",
  APP_NAME,
])("rejects a symlink at %s without modifying its target", async (part) => {
  const path = part === ".rome" ? dirname(parent) : part === APP_NAME ? stagedPath : parent;
  await fs.mkdir(dirname(path), { recursive: true });
  const target = join(home, "elsewhere");
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, path, "dir");
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(false);
  expect(options.execFile).not.toHaveBeenCalled();
  expect(await fs.readdir(target)).toEqual([]);
  expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
});

it("rejects a file or foreign owner at the staging destination", async () => {
  await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(stagedPath, "unrelated");
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(false);
  expect(await fs.readFile(stagedPath, "utf8")).toBe("unrelated");
  await fs.unlink(stagedPath);
  await bundle(stagedPath);
  const stat = await fs.lstat(stagedPath, { bigint: true });
  const foreign = Object.assign(stat, { uid: stat.uid + 1n });
  const lstat = async (path: string) =>
    path === stagedPath ? foreign : fs.lstat(path, { bigint: true });
  expect(await stageComputerUseHelper({ ...options, fs: { ...fs, lstat } })).toBe(false);
  expect(options.execFile).not.toHaveBeenCalled();
});

it.each([
  "symlink",
  "hard link",
])("keeps private files private when an icon is a %s", async (kind) => {
  const secret = join(home, "private");
  await fs.writeFile(secret, "private", { mode: 0o600 });
  const options = fixture();
  const execFile = async (tool: string, args: string[]) => {
    const result = await options.execFile(tool, args);
    if (tool === "/usr/bin/ditto") {
      const copiedIcon = join(args[1], icon);
      await fs.unlink(copiedIcon);
      if (kind === "symlink") await fs.symlink(secret, copiedIcon);
      else await fs.link(secret, copiedIcon);
    }
    return result;
  };
  expect(await stageComputerUseHelper({ ...options, execFile })).toBe(false);
  expect((await fs.stat(secret)).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(parent)).toEqual([]);
});

it("reports the helper as missing when the template and the existing copy both fail verification", async () => {
  await bundle(stagedPath);
  for (const path of [templatePath, stagedPath]) await fs.writeFile(join(path, binary), "unsigned");
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(false);
  expect(options.execFile).toHaveBeenCalledWith(
    "/usr/bin/codesign",
    [...verifyArgs, stagedPath],
    commandOptions,
  );
  expect(options.execFile.mock.calls.some(([tool]) => tool === lsregister)).toBe(false);
  expect(options.log.error).toHaveBeenCalledTimes(1);
});

it("repairs and registers a signed existing copy when the template is unavailable", async () => {
  await bundle(stagedPath);
  const options = fixture();
  expect(
    await stageComputerUseHelper({ ...options, templatePath: join(home, "missing", APP_NAME) }),
  ).toBe(true);
  expect(options.log.warn).toHaveBeenCalled();
  expect((await fs.stat(stagedPath)).mode & 0o777).toBe(0o755);
  expect((await fs.stat(join(stagedPath, icon))).mode & 0o777).toBe(0o644);
  expect(options.execFile).toHaveBeenCalledWith(lsregister, ["-f", stagedPath], commandOptions);
});

it.each([
  "signature",
  "cdhash",
  "rename",
])("preserves the previous signed helper on a copy %s failure", async (fault) => {
  await bundle(stagedPath);
  const previous = "b".repeat(40);
  await fs.writeFile(join(stagedPath, binary), previous);
  const options = fixture();
  const execFile = async (tool: string, args: string[]) => {
    const result = await options.execFile(tool, args);
    if (tool === "/usr/bin/ditto" && fault !== "rename")
      await fs.writeFile(join(args[1], binary), fault === "signature" ? "unsigned" : previous);
    return result;
  };
  const publish = rs.fn<StagingFiles["publish"]>(
    (sourceFd, source, destFd, destination, replace) => {
      const copy = options.execFile.mock.calls.find(([tool]) => tool === "/usr/bin/ditto")![1][1];
      expect(replace).toBe(true);
      expect(source).toBe(APP_NAME);
      expect(fstatSync(sourceFd).ino).toBe(lstatSync(dirname(copy)).ino);
      expect(fstatSync(destFd).ino).toBe(lstatSync(parent).ino);
      expect(readFileSync(join(copy, binary), "utf8")).toBe(hash);
      expect(destination).toBe(APP_NAME);
      expect(readFileSync(join(parent, destination, binary), "utf8")).toBe(previous);
      throw new Error("atomic replacement failed");
    },
  );
  expect(
    await stageComputerUseHelper({
      ...options,
      execFile,
      stagingFiles: { ...options.stagingFiles, publish },
    }),
  ).toBe(true);
  expect(publish).toHaveBeenCalledTimes(fault === "rename" ? 1 : 0);
  expect(publish.mock.calls.some(([, , , , replace]) => !replace)).toBe(false);
  expect(options.log.warn).toHaveBeenCalled();
  expect(options.log.error).not.toHaveBeenCalled();
  expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(previous);
  expect(await fs.readdir(parent)).toEqual([APP_NAME]);
  expect(options.execFile).toHaveBeenCalledWith(lsregister, ["-f", stagedPath]);
});

it("reinstalls a deleted helper after startup and retries a failed first-install rename", async () => {
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(true);
  await fs.rm(stagedPath, { recursive: true });
  const publish = rs.fn(() => {
    throw new Error("publish failed");
  });
  expect(
    await stageComputerUseHelper({
      ...options,
      stagingFiles: { ...options.stagingFiles, publish },
    }),
  ).toBe(false);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(parent)).toEqual([]);
  expect(await stageComputerUseHelper(options)).toBe(true);
  expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(hash);
});

it.each([
  "-u",
  "-f",
  "both",
])("returns the registration result when lsregister fails for %s", async (failed) => {
  const options = fixture();
  const execFile = async (tool: string, args: string[]) => {
    const result = await options.execFile(tool, args);
    if (tool === lsregister && (args[0] === failed || failed === "both"))
      throw new Error("LaunchServices unavailable");
    return result;
  };
  expect(await stageComputerUseHelper({ ...options, execFile })).toBe(failed === "-u");
  expect(options.log.warn).toHaveBeenCalledTimes(failed === "-f" ? 0 : 1);
  expect(options.log.error).toHaveBeenCalledTimes(failed === "-u" ? 0 : 1);
  expect(
    options.execFile.mock.calls.filter(([tool]) => tool === lsregister).map(([, args]) => args),
  ).toEqual([
    ["-u", templatePath],
    ["-f", stagedPath],
  ]);
  expect(await stageComputerUseHelper(options)).toBe(true);
});

it.each([
  ".rome",
  "computer-use",
  "bundle",
])("fails when fallback cannot repair permissions on %s", async (part) => {
  await bundle(stagedPath);
  const path = part === "bundle" ? stagedPath : part === ".rome" ? dirname(parent) : parent;
  const options = fixture();
  const open: typeof fs.open = async (file, ...args) => {
    const handle = await fs.open(file, ...args);
    if (file === path)
      rs.spyOn(handle, "chmod").mockImplementation(async () => {
        throw new Error("permission repair failed");
      });
    return handle;
  };
  await fs.chmod(path, 0o755);
  const execFile = async (tool: string, args: string[]) => {
    if (args.at(-1) === templatePath) {
      await fs.chmod(path, 0o700);
      throw new Error("template unavailable");
    }
    return options.execFile(tool, args);
  };
  expect(await stageComputerUseHelper({ ...options, fs: { ...fs, open }, execFile })).toBe(false);
  expect(options.log.error).toHaveBeenCalledWith(
    expect.stringContaining("permission repair failed"),
  );
  expect(options.execFile.mock.calls.some(([tool]) => tool === lsregister)).toBe(false);
});

it("kills a hung staging command at the configured deadline and releases the lock", async () => {
  const options = fixture();
  const execFile = rs.fn<NonNullable<Parameters<typeof stageComputerUseHelper>[0]["execFile"]>>(
    (_tool, _args, opts) =>
      promisify(nodeExecFile)(process.execPath, ["-e", "setInterval(() => {}, 1000)"], opts),
  );
  expect(await stageComputerUseHelper({ ...options, execFile, commandTimeoutMs: 50 })).toBe(false);
  expect(execFile).toHaveBeenCalledWith("/usr/bin/codesign", [...verifyArgs, templatePath], {
    ...commandOptions,
    timeout: 50,
  });
  await expect(execFile.mock.results[0].value).rejects.toMatchObject({
    killed: true,
    signal: "SIGKILL",
  });
  expect(options.log.error).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(parent)).toEqual([]);
  expect(await stageComputerUseHelper(options)).toBe(true);
});

it("leaves another process's staging directory alone and recovers its lock after a crash", async () => {
  const active = join(parent, ".Rome Computer Use.staging-active");
  await fs.mkdir(active, { recursive: true });
  const lock = join(parent, ".Rome Computer Use.lock");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const fd = require("node:fs").openSync(process.argv[1], "wx", 0o600);
    const flock = require(process.argv[2]).load(null).func("int flock(int, int)");
    if (flock(fd, 6) !== 0) process.exit(1);
    process.send("locked");
    setInterval(() => {}, 1000);
  `,
      lock,
      require.resolve("koffi"),
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const deadline = AbortSignal.timeout(3_000);
  const exit = once(child, "exit", { signal: deadline });
  try {
    await Promise.race([
      once(child, "message", { signal: deadline }),
      exit.then(() => {
        throw new Error("child did not lock");
      }),
    ]);
    const options = fixture();
    expect(await stageComputerUseHelper({ ...options, lockWaitMs: 50 })).toBe(false);
    expect(options.execFile).not.toHaveBeenCalled();
    expect((await fs.lstat(active)).isDirectory()).toBe(true);
    const repair = stageComputerUseHelper(options);
    child.kill("SIGKILL");
    await exit;
    expect(await repair).toBe(true);
    expect(await fs.readdir(parent)).toEqual([APP_NAME]);
  } finally {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "exit", { signal: AbortSignal.timeout(1_000) });
  }
});

it.each([
  ".rome",
  "computer-use",
])("refuses to publish or clean a replacement %s directory", async (part) => {
  const options = fixture();
  const root = part === ".rome" ? dirname(parent) : parent;
  const stale = join(parent, ".Rome Computer Use.old-other");
  const execFile = async (tool: string, args: string[]) => {
    const result = await options.execFile(tool, args);
    if (tool === "/usr/bin/plutil" && args.at(-1)!.includes(".staging-")) {
      await fs.rename(root, root + "-original");
      await fs.mkdir(stale, { recursive: true });
    }
    return result;
  };
  const publish = rs.fn(options.stagingFiles.publish);
  expect(
    await stageComputerUseHelper({
      ...options,
      execFile,
      stagingFiles: { ...options.stagingFiles, publish },
    }),
  ).toBe(false);
  expect(publish).not.toHaveBeenCalled();
  expect((await fs.lstat(stale)).isDirectory()).toBe(true);
  expect(await fs.readdir(parent)).toEqual([".Rome Computer Use.old-other"]);
});

it("opens and unlinks the lock in the pinned parent after its pathname changes", async () => {
  const options = fixture();
  const original = parent + "-original";
  const openAt: StagingFiles["openAt"] = (fd, name, ...flags) => {
    renameSync(parent, original);
    mkdirSync(parent);
    writeFileSync(join(parent, name), "replacement", { mode: 0o600 });
    const lockFd = options.stagingFiles.openAt(fd, name, ...flags);
    expect(lstatSync(join(original, name)).isFile()).toBe(true);
    return lockFd;
  };
  expect(
    await stageComputerUseHelper({
      ...options,
      stagingFiles: { ...options.stagingFiles, openAt },
    }),
  ).toBe(false);
  expect(await fs.readdir(original)).toEqual([]);
  expect(await fs.readFile(join(parent, ".Rome Computer Use.lock"), "utf8")).toBe("replacement");
});

it("publishes and cleans the copy in the pinned parent after its pathname changes", async () => {
  const options = fixture();
  const original = parent + "-original";
  let tempName = "";
  const publish: StagingFiles["publish"] = (sourceFd, source, destFd, destination, replace) => {
    const copy = options.execFile.mock.calls.find(([tool]) => tool === "/usr/bin/ditto")![1][1];
    tempName = basename(dirname(copy));
    renameSync(parent, original);
    mkdirSync(join(parent, tempName, source), { recursive: true });
    writeFileSync(join(parent, tempName, source, "marker"), "replacement");
    mkdirSync(join(original, tempName, "nested"));
    writeFileSync(join(original, tempName, "nested", "file"), "cleanup");
    options.stagingFiles.publish(sourceFd, source, destFd, destination, replace);
  };
  expect(
    await stageComputerUseHelper({
      ...options,
      stagingFiles: { ...options.stagingFiles, publish },
    }),
  ).toBe(false);
  expect(await fs.readdir(original)).toEqual([APP_NAME]);
  expect(await fs.readFile(join(original, APP_NAME, binary), "utf8")).toBe(hash);
  expect(await fs.readdir(parent)).toEqual([tempName]);
  expect(await fs.readFile(join(parent, tempName, APP_NAME, "marker"), "utf8")).toBe("replacement");
});

it("preserves a destination created immediately before exclusive first publication", async () => {
  const options = fixture();
  const publish: StagingFiles["publish"] = (...args) => {
    mkdirSync(stagedPath);
    options.stagingFiles.publish(...args);
  };
  expect(
    await stageComputerUseHelper({
      ...options,
      stagingFiles: { ...options.stagingFiles, publish },
    }),
  ).toBe(false);
  expect(await fs.readdir(stagedPath)).toEqual([]);
  expect(await fs.readdir(parent)).toEqual([APP_NAME]);
});

it.each([
  "published",
  "matching",
  "fallback",
])("refuses to register a replaced %s inode", async (kind) => {
  if (kind !== "published") await bundle(stagedPath);
  if (kind === "fallback") await fs.unlink(join(templatePath, binary));
  const options = fixture();
  const execFile = async (tool: string, args: string[]) => {
    if (tool === lsregister && args[0] === "-u") {
      await fs.rename(stagedPath, join(home, "verified"));
      await bundle(stagedPath);
    }
    return options.execFile(tool, args);
  };
  expect(await stageComputerUseHelper({ ...options, execFile })).toBe(false);
  expect(options.execFile).toHaveBeenCalledWith(lsregister, ["-u", templatePath]);
  expect(options.execFile).not.toHaveBeenCalledWith(lsregister, ["-f", stagedPath]);
  expect(options.log.error).toHaveBeenCalledWith(
    expect.stringContaining("Helper destination changed"),
  );
});

it("cleans stale subdirectories through the pinned parent without following their symlinks", async () => {
  const options = fixture();
  const original = parent + "-original";
  const stale = ".Rome Computer Use.old-nested";
  await bundle(stagedPath);
  await fs.mkdir(join(parent, stale, "sub"), { recursive: true });
  await fs.symlink(templatePath, join(parent, stale, "sub", "template"));
  const parentInode = (await fs.stat(parent)).ino;
  const names = rs.fn((fd: number) => {
    if (fstatSync(fd).ino === parentInode) {
      renameSync(parent, original);
      mkdirSync(join(parent, stale, "sub"), { recursive: true });
      writeFileSync(join(parent, stale, "sub", "marker"), "replacement");
    }
    return options.stagingFiles.names(fd);
  });
  expect(
    await stageComputerUseHelper({
      ...options,
      stagingFiles: { ...options.stagingFiles, names },
    }),
  ).toBe(false);
  expect(await fs.readdir(original)).toEqual([APP_NAME]);
  expect(await fs.readFile(join(parent, stale, "sub", "marker"), "utf8")).toBe("replacement");
  expect(await fs.readFile(join(templatePath, binary), "utf8")).toBe(hash);
});

it("closes the lock and nested directory descriptors when cleanup fails", async () => {
  const options = fixture();
  const stale = join(parent, ".Rome Computer Use.old-stale/sub");
  await fs.mkdir(stale, { recursive: true });
  await fs.writeFile(join(stale, "file"), "keep");
  const opened: number[] = [];
  const stagingFiles: StagingFiles = {
    ...options.stagingFiles,
    openAt(...args) {
      const fd = options.stagingFiles.openAt(...args);
      opened.push(fd);
      return fd;
    },
    unlinkAt(fd, name, directory) {
      if (name === "file") throw new Error("cleanup failed");
      options.stagingFiles.unlinkAt(fd, name, directory);
    },
  };
  expect(await stageComputerUseHelper({ ...options, stagingFiles })).toBe(true);
  expect(options.log.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"));
  expect(await fs.readFile(join(stale, "file"), "utf8")).toBe("keep");
  expect(opened.length).toBeGreaterThanOrEqual(3);
  for (const fd of opened) expect(() => fstatSync(fd)).toThrow(/EBADF/);
});

it("preserves a replaced lock, stale symlinks and foreign directories", async () => {
  const options = fixture();
  await fs.mkdir(parent, { recursive: true });
  const foreign = join(parent, ".Rome Computer Use.old-other");
  const link = join(parent, ".Rome Computer Use.staging-link");
  const lock = join(parent, ".Rome Computer Use.lock");
  await fs.mkdir(foreign);
  await fs.symlink(foreign, link);
  const statAt: StagingFiles["statAt"] = (fd, name) => {
    const info = options.stagingFiles.statAt(fd, name);
    if (info && name === basename(foreign)) info.uid++;
    return info;
  };
  const execFile = async (tool: string, args: string[]) => {
    if (tool === lsregister && args[0] === "-f") {
      await fs.unlink(lock);
      await fs.writeFile(lock, "new owner", { mode: 0o600 });
    }
    return options.execFile(tool, args);
  };
  expect(
    await stageComputerUseHelper({
      ...options,
      execFile,
      stagingFiles: { ...options.stagingFiles, statAt },
    }),
  ).toBe(true);
  expect(await fs.readFile(lock, "utf8")).toBe("new owner");
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  expect((await fs.lstat(foreign)).isDirectory()).toBe(true);
});

it.each([
  "registration",
  "mode repair",
])("keeps a copied helper unavailable to Settings until %s succeeds", async (fault) => {
  const options = fixture();
  let fail = true;
  rs.mocked(launchPermissionSetup).mockClear();
  rs.mocked(shell.openExternal).mockClear();
  const execFile = async (tool: string, args: string[]) => {
    const result = await options.execFile(tool, args);
    if (fail && tool === lsregister && args[0] === "-f") {
      if (fault === "mode repair") await fs.chmod(parent, 0o700);
      throw new Error("registration failed");
    }
    return result;
  };
  const open: typeof fs.open = async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    if (fail && fault === "mode repair" && path === parent) {
      rs.spyOn(handle, "chmod").mockRejectedValue(new Error("mode repair failed"));
    }
    return handle;
  };
  const helper = createStagedComputerUseHelper({
    ...options,
    stagedPath,
    fs: { ...fs, open },
    execFile,
  });
  const settings = createComputerUseSettings(stagedPath, () => true, helper);
  expect(await helper.ensureHelper()).toBe(false);
  expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(hash);
  expect(settings.status().helperPresent).toBe(false);
  await settings.setup();
  expect(launchPermissionSetup).not.toHaveBeenCalled();
  expect(shell.openExternal).toHaveBeenCalledWith(expect.stringContaining("Privacy_Accessibility"));
  if (fault === "mode repair")
    expect(options.log.error).toHaveBeenCalledWith(expect.stringContaining("mode repair failed"));
  fail = false;
  await settings.setup();
  expect(settings.status().helperPresent).toBe(true);
  expect(launchPermissionSetup).toHaveBeenCalledWith({ appPath: stagedPath });
  options.execFile.mockClear();
  expect(await helper.ensureHelper()).toBe(true);
  expect(options.execFile).not.toHaveBeenCalled();
  await fs.rm(stagedPath, { recursive: true });
  expect(settings.status().helperPresent).toBe(false);
  expect(await helper.ensureHelper()).toBe(true);
  expect(settings.status().helperPresent).toBe(true);
});

it("shares a failed registration with requests arriving after a deleted helper is republished", async () => {
  const options = fixture();
  let registration: Promise<void> | undefined;
  let register!: () => void;
  const reached = new Promise<void>((resolve) => {
    register = resolve;
  });
  const execFile = async (tool: string, args: string[]) => {
    const result = await options.execFile(tool, args);
    if (registration && tool === lsregister && args[0] === "-f") {
      register();
      await registration;
      throw new Error("registration failed");
    }
    return result;
  };
  const helper = createStagedComputerUseHelper({ ...options, stagedPath, execFile });
  expect(await helper.ensureHelper()).toBe(true);
  await fs.rm(stagedPath, { recursive: true });
  let release!: () => void;
  registration = new Promise<void>((resolve) => {
    release = resolve;
  });
  const repair = helper.ensureHelper();
  try {
    await Promise.race([
      reached,
      repair.then(() => {
        throw new Error("registration was not reached");
      }),
    ]);
    expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(hash);
    expect(helper.helperReady()).toBe(false);
    const concurrent = helper.ensureHelper();
    release();
    expect(await Promise.all([repair, concurrent])).toEqual([false, false]);
  } finally {
    release();
    await repair;
  }
});

it("repairs a missing Info.plist and forces repair after the guide rejects a damaged signature", async () => {
  const helper = createStagedComputerUseHelper({ ...fixture(), stagedPath });
  const settings = createComputerUseSettings(stagedPath, () => true, helper);
  expect(await helper.ensureHelper()).toBe(true);
  await fs.unlink(join(stagedPath, plist));
  expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(hash);
  expect(helper.helperReady()).toBe(false);
  expect(settings.status().helperPresent).toBe(false);
  expect(await helper.ensureHelper()).toBe(true);
  expect(JSON.parse(await fs.readFile(join(stagedPath, plist), "utf8"))).toEqual(version);
  expect(settings.status().helperPresent).toBe(true);

  await fs.writeFile(join(stagedPath, binary), "unsigned");
  rs.mocked(launchPermissionSetup)
    .mockReset()
    .mockImplementation(async () => {
      if ((await fs.readFile(join(stagedPath, binary), "utf8")) !== hash)
        throw new Error("invalid signature");
    });
  rs.mocked(shell.openExternal).mockClear();
  try {
    await settings.open("screenRecording");
    expect(launchPermissionSetup).toHaveBeenCalledTimes(2);
    expect(launchPermissionSetup).toHaveBeenLastCalledWith({
      appPath: stagedPath,
      pane: "screen-recording",
    });
    expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(hash);
    expect(shell.openExternal).not.toHaveBeenCalled();
  } finally {
    rs.mocked(launchPermissionSetup).mockReset();
  }
});

it("uses the development host's discovery order for Settings status, setup and reveal", async () => {
  const override = join(home, "override", APP_NAME);
  await bundle(override);
  const settings = createComputerUseSettings(
    () => findInstalledHelper({ platform: "darwin", bundledAppPath: templatePath }),
    () => true,
  );
  rs.stubEnv("ROME_NODE_COMPUTER_USE_HELPER", override);
  try {
    expect(settings.status().helperPresent).toBe(true);
    await settings.setup();
    expect(launchPermissionSetup).toHaveBeenLastCalledWith({ appPath: override });
    await settings.revealHelper();
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(override);
    await fs.rm(override, { recursive: true });
    expect(settings.status().helperPresent).toBe(false);
  } finally {
    rs.unstubAllEnvs();
  }
  await settings.setup();
  expect(launchPermissionSetup).toHaveBeenLastCalledWith({ appPath: templatePath });
});

it("does no staging on other platforms", async () => {
  const options = fixture();
  expect(await stageComputerUseHelper({ ...options, platform: "linux" })).toBe(false);
  expect(options.execFile).not.toHaveBeenCalled();
  await expect(fs.lstat(dirname(parent))).rejects.toMatchObject({ code: "ENOENT" });
});
