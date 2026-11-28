import { execFile as nodeExecFile } from "node:child_process";
import { lstatSync, renameSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import {
  createStagedComputerUseHelper,
  stageComputerUseHelper,
  type PublishBundle,
  type StagingOptions,
} from "./computer-use-staging";

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

async function bundle(path: string, signature = hash, info = version) {
  await fs.mkdir(join(path, "Contents/MacOS"), { recursive: true, mode: 0o700 });
  await fs.mkdir(join(path, "Contents/Resources"), { mode: 0o700 });
  await fs.writeFile(join(path, binary), signature, { mode: 0o700 });
  await fs.writeFile(join(path, icon), "icon", { mode: 0o600 });
  await fs.writeFile(join(path, plist), JSON.stringify(info), { mode: 0o600 });
}

// Linux CI exercises staging with standard rename while macOS exercises the real renameatx_np binding.
const linuxPublish: PublishBundle = (source, destination, replace) => {
  if (replace) renameSync(destination, join(dirname(source), "previous"));
  else if (lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error("destination exists");
  }
  renameSync(source, destination);
};

function fixture() {
  const log = { warn: rs.fn(), error: rs.fn() };
  const execFile = rs.fn<NonNullable<StagingOptions["execFile"]>>(async (tool, args) => {
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
    publish: process.platform === "darwin" ? undefined : linuxPublish,
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

it("stages into ~/.rome-computer-use, coalesces calls, repairs modes on cache hit, and never touches ~/.rome", async () => {
  const options = fixture();
  const romeDir = join(home, ".rome");
  const token = join(romeDir, "store-token.json");
  const profileDir = join(romeDir, "default");
  await fs.mkdir(profileDir, { recursive: true, mode: 0o755 });
  await fs.chmod(romeDir, 0o700);
  await fs.writeFile(token, "private", { mode: 0o600 });

  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.mkdir(join(parent, ".Rome Computer Use.staging-stale"));
  await fs.mkdir(join(parent, ".Rome Computer Use.old-stale"));
  await fs.mkdir(join(parent, "unrelated"));

  const install = { ...options, staleCleanupMs: 0 };
  await expect(
    Promise.all([stageComputerUseHelper(install), stageComputerUseHelper(install)]),
  ).resolves.toEqual([true, true]);

  const original = await fs.stat(stagedPath);
  await fs.chmod(stagedPath, 0o700);
  await fs.chmod(join(stagedPath, icon), 0o600);
  await expect(stageComputerUseHelper(install)).resolves.toBe(true);
  expect((await fs.stat(stagedPath)).ino).toBe(original.ino);

  const copies = options.execFile.mock.calls.filter(([tool]) => tool === "/usr/bin/ditto");
  expect(copies).toHaveLength(1);
  expect(options.execFile).toHaveBeenCalledWith("/usr/bin/ditto", [templatePath, copies[0][1][1]], {
    ...commandOptions,
    timeout: 30_000,
  });
  expect(options.execFile.mock.calls.filter(([tool]) => tool === lsregister)).toEqual([
    [lsregister, ["-u", templatePath], commandOptions],
    [lsregister, ["-f", stagedPath], commandOptions],
    [lsregister, ["-u", templatePath], commandOptions],
    [lsregister, ["-f", stagedPath], commandOptions],
  ]);

  expect((await fs.lstat(parent)).mode & 0o777).toBe(0o755);
  expect((await fs.lstat(stagedPath)).mode & 0o777).toBe(0o755);
  expect((await fs.lstat(join(stagedPath, plist))).mode & 0o777).toBe(0o644);
  expect((await fs.lstat(join(stagedPath, icon))).mode & 0o777).toBe(0o644);
  expect((await fs.readdir(parent)).sort()).toEqual([APP_NAME, "unrelated"]);

  // Shared private ~/.rome state must remain completely untouched.
  expect((await fs.lstat(romeDir)).mode & 0o777).toBe(0o700);
  expect((await fs.lstat(token)).mode & 0o777).toBe(0o600);
  expect((await fs.lstat(profileDir)).mode & 0o777).toBe(0o755);
  expect(options.log.warn).not.toHaveBeenCalled();
  expect(options.log.error).not.toHaveBeenCalled();
});

it.each([
  ["CDHash", async () => fs.writeFile(join(templatePath, binary), "b".repeat(40))],
  [
    "build",
    async () =>
      fs.writeFile(join(templatePath, plist), JSON.stringify({ ...version, CFBundleVersion: "2" })),
  ],
  [
    "version",
    async () =>
      fs.writeFile(
        join(templatePath, plist),
        JSON.stringify({ ...version, CFBundleShortVersionString: "1.1" }),
      ),
  ],
])("atomically replaces the staged helper when template %s changes", async (_field, update) => {
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(true);
  const firstInode = (await fs.stat(stagedPath)).ino;
  await update();
  expect(await stageComputerUseHelper(options)).toBe(true);
  expect((await fs.stat(stagedPath)).ino).not.toBe(firstInode);
  expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(
    await fs.readFile(join(templatePath, binary), "utf8"),
  );
  expect(await fs.readFile(join(stagedPath, plist), "utf8")).toBe(
    await fs.readFile(join(templatePath, plist), "utf8"),
  );
  expect(await fs.readdir(parent)).toEqual([APP_NAME]);
});

it("replaces a matching staged helper when an internal entry cannot be repaired in place", async () => {
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(true);
  const foreignUid = process.getuid!() + 1;
  const stagedPlist = join(stagedPath, plist);
  let replaced = false;
  const stagedFs: NonNullable<StagingOptions["fs"]> = {
    ...fs,
    async lstat(path) {
      const info = await fs.lstat(path);
      if (!replaced && path === stagedPlist) {
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { uid: foreignUid });
      }
      return info;
    },
  };
  const basePublish = options.publish;
  const publish: PublishBundle | undefined = basePublish
    ? async (src, dst, replace) => {
        await basePublish(src, dst, replace);
        replaced = true;
      }
    : undefined;
  const helper = createStagedComputerUseHelper({
    ...options,
    stagedPath,
    fs: stagedFs,
    ...(publish
      ? { publish }
      : {
          execFile: async (tool, args, opts) => {
            const res = await options.execFile(tool, args, opts);
            if (tool === "/usr/bin/ditto") replaced = true;
            return res;
          },
        }),
  });
  expect(await helper.ensureHelper({ force: true })).toBe(true);
  expect(options.execFile.mock.calls.filter(([tool]) => tool === "/usr/bin/ditto")).toHaveLength(2);
  expect(options.log.error).not.toHaveBeenCalled();
});

it("still registers the published helper if cleaning up the swapped-out copy fails", async () => {
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(true);
  const nextHash = "b".repeat(40);
  await fs.writeFile(join(templatePath, binary), nextHash);
  const rm = rs.fn(async () => {
    throw new Error("EACCES: cleanup failed");
  });
  expect(await stageComputerUseHelper({ ...options, fs: { ...fs, rm } })).toBe(true);
  expect(await fs.readFile(join(stagedPath, binary), "utf8")).toBe(nextHash);
  expect(options.execFile.mock.calls.filter(([tool]) => tool === lsregister)).toContainEqual([
    lsregister,
    ["-f", stagedPath],
    commandOptions,
  ]);
  expect(options.log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not clean up"));
  expect(options.log.error).not.toHaveBeenCalled();
});

it.each([
  ["parent symlink", async () => fs.symlink(home, parent)],
  ["parent file", async () => fs.writeFile(parent, "not a dir")],
  [
    "destination symlink",
    async () => {
      await fs.mkdir(parent, { recursive: true });
      await fs.symlink(templatePath, stagedPath);
    },
  ],
  [
    "destination file",
    async () => {
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(stagedPath, "not a bundle");
    },
  ],
])("rejects %s without modifying or registering it", async (_label, setup) => {
  await setup();
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(false);
  expect(options.execFile).not.toHaveBeenCalled();
  expect(options.log.error).toHaveBeenCalledTimes(1);
});

it("rejects a foreign-owned staging directory or destination", async () => {
  const options = fixture();
  await fs.mkdir(stagedPath, { recursive: true });
  const foreignUid = process.getuid!() + 1;
  for (const target of [parent, stagedPath]) {
    const stagedFs: NonNullable<StagingOptions["fs"]> = {
      ...fs,
      async lstat(path) {
        const info = await fs.lstat(path);
        if (path === target) {
          return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
            uid: foreignUid,
          });
        }
        return info;
      },
    };
    expect(await stageComputerUseHelper({ ...options, fs: stagedFs })).toBe(false);
  }
  expect(options.execFile).not.toHaveBeenCalled();
  expect(options.log.error).toHaveBeenCalledTimes(2);
});

it("keeps and repairs a signed existing copy when the template is unavailable, and fails when both are invalid", async () => {
  const options = fixture();
  expect(await stageComputerUseHelper(options)).toBe(true);
  await fs.writeFile(join(templatePath, binary), "unsigned");
  await fs.chmod(join(stagedPath, icon), 0o600);

  expect(await stageComputerUseHelper(options)).toBe(true);
  expect((await fs.lstat(join(stagedPath, icon))).mode & 0o777).toBe(0o644);
  expect(options.log.warn).toHaveBeenCalledWith(expect.stringContaining("Using the signed copy"));
  expect(options.log.error).not.toHaveBeenCalled();

  await fs.writeFile(join(stagedPath, binary), "unsigned");
  expect(await stageComputerUseHelper(options)).toBe(false);
  expect(options.log.error).toHaveBeenCalledTimes(1);
});

it("tolerates lsregister -u warnings and fails when lsregister -f fails", async () => {
  const options = fixture();
  let failFlag = "-u";
  const execFile: NonNullable<StagingOptions["execFile"]> = async (tool, args, opts) => {
    if (tool === lsregister && args[0] === failFlag) throw new Error(`lsregister ${failFlag} boom`);
    return options.execFile(tool, args, opts);
  };
  expect(await stageComputerUseHelper({ ...options, execFile })).toBe(true);
  expect(options.log.warn).toHaveBeenCalledWith(expect.stringContaining("lsregister -u"));

  failFlag = "-f";
  expect(await stageComputerUseHelper({ ...options, execFile })).toBe(false);
  expect(options.log.error).toHaveBeenCalledTimes(1);
});

it("kills a hung staging command at the configured timeout", async () => {
  const options = fixture();
  const execFile = rs.fn<NonNullable<StagingOptions["execFile"]>>((_tool, _args, opts) =>
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

it("leaves fresh in-flight staging directories alone during stale cleanup", async () => {
  const options = fixture();
  const active = join(parent, ".Rome Computer Use.staging-active");
  await fs.mkdir(active, { recursive: true });
  expect(await stageComputerUseHelper(options)).toBe(true);
  expect((await fs.readdir(parent)).sort()).toEqual([
    ".Rome Computer Use.staging-active",
    APP_NAME,
  ]);
});

it("reports the bundled helper as present while Computer Use is off and stages lazily on setup or reveal", async () => {
  const options = fixture();
  const onReadyChange = rs.fn();
  const helper = createStagedComputerUseHelper({ ...options, stagedPath, onReadyChange });
  const settings = createComputerUseSettings(stagedPath, () => false, helper);

  // Before staging runs, the bundled template makes the helper available in the tray.
  expect(helper.helperReady()).toBe(false);
  expect(settings.status()).toEqual({ enabled: false, helperPresent: true });
  expect(options.execFile).not.toHaveBeenCalled();

  // Clicking setup or reveal stages into ~/.rome-computer-use on demand.
  await settings.setup();
  expect(launchPermissionSetup).toHaveBeenLastCalledWith({ appPath: stagedPath });
  expect(helper.helperReady()).toBe(true);
  expect(settings.status()).toEqual({ enabled: false, helperPresent: true });
  expect(onReadyChange).not.toHaveBeenCalled();

  await settings.revealHelper();
  expect(shell.showItemInFolder).toHaveBeenLastCalledWith(stagedPath);
});

it("notifies onReadyChange on staging failure/recovery and repairs missing Info.plist or damaged signatures", async () => {
  const options = fixture();
  const onReadyChange = rs.fn();
  const helper = createStagedComputerUseHelper({ ...options, stagedPath, onReadyChange });
  const settings = createComputerUseSettings(stagedPath, () => true, helper);

  // If initial staging fails, availability flips to false and notifies the tray.
  await fs.writeFile(join(templatePath, binary), "unsigned");
  expect(settings.status().helperPresent).toBe(true);
  expect(await helper.ensureHelper()).toBe(false);
  expect(settings.status().helperPresent).toBe(false);
  expect(onReadyChange).toHaveBeenCalledTimes(1);

  // Once the template is valid, retry flips availability back to true.
  await fs.writeFile(join(templatePath, binary), hash);
  expect(await helper.ensureHelper()).toBe(true);
  expect(settings.status().helperPresent).toBe(true);
  expect(onReadyChange).toHaveBeenCalledTimes(2);

  await fs.unlink(join(stagedPath, plist));
  expect(helper.helperReady()).toBe(false);
  expect(settings.status().helperPresent).toBe(false);
  expect(await helper.ensureHelper()).toBe(true);
  expect(onReadyChange).toHaveBeenCalledTimes(3);
  expect(JSON.parse(await fs.readFile(join(stagedPath, plist), "utf8"))).toEqual(version);
  expect(settings.status().helperPresent).toBe(true);

  await fs.writeFile(join(stagedPath, binary), "unsigned");
  rs.mocked(launchPermissionSetup)
    .mockReset()
    .mockImplementation(async () => {
      if ((await fs.readFile(join(stagedPath, binary), "utf8")) !== hash) {
        throw new Error("invalid signature");
      }
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

it("shares a failed registration with concurrent requests arriving after a deleted helper is republished", async () => {
  const options = fixture();
  let registration: Promise<void> | undefined;
  let register!: () => void;
  const reached = new Promise<void>((resolve) => {
    register = resolve;
  });
  const execFile: NonNullable<StagingOptions["execFile"]> = async (tool, args, opts) => {
    const result = await options.execFile(tool, args, opts);
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
  await expect(fs.lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
});
