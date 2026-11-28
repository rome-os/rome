import { execFile as nodeExecFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import * as files from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  APP_NAME,
  type EnsureComputerUseHelper,
  hasStagedHelperDirectory,
  RELEASE_SIGNING_REQUIREMENT,
  stagedHelperPath,
} from "@rome-os/node-core/host";
import { parseCdhash } from "./app-shims/bundle";

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const stagingPrefix = ".Rome Computer Use.staging-";
const backupPrefix = ".Rome Computer Use.old-";
const executable = "Contents/MacOS/RomeComputerUse";
const defaultStaleCleanupMs = 5 * 60_000;

const AT_FDCWD = -2;
const RENAME_SWAP = 2;
const RENAME_EXCL = 4;

const execFileAsync = promisify(nodeExecFile);

export type PublishBundle = (
  source: string,
  destination: string,
  replace: boolean,
) => void | Promise<void>;

export interface StagingOptions {
  templatePath: string;
  stagedPath?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fs?: Pick<typeof files, "access" | "chmod" | "lstat" | "mkdir" | "mkdtemp" | "readdir" | "rm">;
  execFile?: (
    tool: string,
    args: string[],
    options: { timeout: number; killSignal: "SIGKILL"; encoding: "utf8" },
  ) => Promise<{ stdout: string; stderr: string }>;
  publish?: PublishBundle;
  commandTimeoutMs?: number;
  staleCleanupMs?: number;
  onReadyChange?: () => void;
  log: { warn(message: string): void; error(message: string): void };
}

let darwinRenameatx:
  | ((fromFd: number, from: string, toFd: number, to: string, flags: number) => number)
  | undefined;

// Atomic bundle publish via Darwin renameatx_np so the staged path is never missing during updates.
function darwinPublish(source: string, destination: string, replace: boolean): void {
  const koffi = require("koffi") as typeof import("koffi");
  darwinRenameatx ??= koffi
    .load(null)
    .func("int renameatx_np(int, const char *, int, const char *, unsigned int)");
  const primary = replace ? RENAME_SWAP : RENAME_EXCL;
  if (darwinRenameatx(AT_FDCWD, source, AT_FDCWD, destination, primary) === 0) return;
  let errno = koffi.errno();
  const fallback =
    !replace && errno === koffi.os.errno.EEXIST
      ? RENAME_SWAP
      : replace && errno === koffi.os.errno.ENOENT
        ? RENAME_EXCL
        : undefined;
  if (fallback !== undefined) {
    if (darwinRenameatx(AT_FDCWD, source, AT_FDCWD, destination, fallback) === 0) return;
    errno = koffi.errno();
  }
  throw new Error(`renameatx_np failed (errno ${errno})`);
}

export function createStagedComputerUseHelper(options: StagingOptions & { stagedPath: string }) {
  let stagedReady = false;
  const helperReady = () =>
    stagedReady &&
    hasStagedHelperDirectory(options.stagedPath) &&
    existsSync(join(options.stagedPath, executable)) &&
    existsSync(join(options.stagedPath, "Contents/Info.plist"));
  const ensureHelper: EnsureComputerUseHelper = async (callOptions) => {
    const wasReady = helperReady();
    if (!callOptions?.force && wasReady) return true;
    // A copied executable can appear before its permissions and registration are ready.
    stagedReady = false;
    const next = await stageComputerUseHelper(options);
    stagedReady = next;
    if (next !== wasReady) options.onReadyChange?.();
    return next;
  };
  return { ensureHelper, helperReady };
}

// Concurrent calls in the same process share one staging run.
const staging = new Map<string, Promise<boolean>>();

export function stageComputerUseHelper(options: StagingOptions): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return Promise.resolve(false);
  const path = options.stagedPath ?? stagedHelperPath(options.homeDir);
  const active = staging.get(path);
  if (active) return active;
  const result = syncHelper(options, path)
    .catch((error) => {
      options.log.error(`Computer Use helper unavailable at ${path}: ${error}`);
      return false;
    })
    .finally(() => staging.delete(path));
  staging.set(path, result);
  return result;
}

async function syncHelper(options: StagingOptions, stagedPath: string): Promise<boolean> {
  const { templatePath, log, fs = files, publish = darwinPublish } = options;
  const parent = dirname(stagedPath);
  const uid = process.getuid!();
  const staleCleanupMs = options.staleCleanupMs ?? defaultStaleCleanupMs;

  function execFile(tool: string, args: string[]) {
    return (options.execFile ?? execFileAsync)(tool, args, {
      timeout: options.commandTimeoutMs ?? (tool === "/usr/bin/ditto" ? 30_000 : 15_000),
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
  }

  async function ownedDirectory(path: string) {
    const info = await fs.lstat(path);
    if (!info.isDirectory() || info.uid !== uid) {
      throw new Error(`Unsafe helper directory: ${path}`);
    }
    return info;
  }

  async function setMode(path: string, directory: boolean) {
    const info = await fs.lstat(path);
    if (info.uid !== uid || (directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Unsafe helper bundle entry: ${path}`);
    }
    const mode = directory ? 0o755 : 0o644;
    if ((info.mode & 0o7777) !== mode) await fs.chmod(path, mode);
  }

  // iconservicesagent runs as a separate user and needs traversal + read access for the app icon.
  async function makeReadable(app: string) {
    for (const directory of ["", "Contents", "Contents/MacOS", "Contents/Resources"]) {
      await setMode(join(app, directory), true);
    }
    await setMode(join(app, "Contents/Info.plist"), false);
    const resources = join(app, "Contents/Resources");
    for (const name of await fs.readdir(resources)) {
      if (name.endsWith(".icns")) await setMode(join(resources, name), false);
    }
  }

  async function verify(app: string) {
    for (const directory of [app, join(app, "Contents"), join(app, "Contents/MacOS")]) {
      if (!(await fs.lstat(directory)).isDirectory()) {
        throw new Error(`Invalid helper: ${directory}`);
      }
    }
    const binary = join(app, executable);
    if (!(await fs.lstat(binary)).isFile()) {
      throw new Error(`Invalid helper executable: ${binary}`);
    }
    await fs.access(binary, constants.X_OK);
    await execFile("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      `-R=${RELEASE_SIGNING_REQUIREMENT}`,
      app,
    ]);
  }

  async function identity(app: string) {
    await verify(app);
    const { stdout, stderr } = await execFile("/usr/bin/codesign", [
      "--display",
      "--verbose=3",
      app,
    ]);
    const cdhash = parseCdhash(`${stderr}\n${stdout}`);
    const plist = await execFile("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(app, "Contents/Info.plist"),
    ]);
    const { CFBundleVersion: build, CFBundleShortVersionString: version } = JSON.parse(
      plist.stdout,
    );
    if (!cdhash || typeof build !== "string" || !build || typeof version !== "string" || !version) {
      throw new Error(`Invalid helper identity: ${app}`);
    }
    return { cdhash, build, version };
  }

  async function syncBundle(hasExisting: boolean) {
    const template = await identity(templatePath);
    const matches = (other: typeof template) =>
      other.cdhash === template.cdhash &&
      other.build === template.build &&
      other.version === template.version;
    if (hasExisting && (await identity(stagedPath).then(matches, () => false))) {
      if (
        await makeReadable(stagedPath).then(
          () => true,
          () => false,
        )
      ) {
        return;
      }
    }
    const tempDir = await fs.mkdtemp(join(parent, stagingPrefix));
    try {
      const copy = join(tempDir, APP_NAME);
      await execFile("/usr/bin/ditto", [templatePath, copy]);
      await makeReadable(copy);
      if (!matches(await identity(copy))) {
        throw new Error("Copied helper identity differs from the template");
      }
      await publish(copy, stagedPath, hasExisting);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch((error) => {
        log.warn(`Could not clean up ${tempDir}: ${error}`);
      });
    }
  }

  await fs.mkdir(parent, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const parentInfo = await ownedDirectory(parent);
  if ((parentInfo.mode & 0o7777) !== 0o755) await fs.chmod(parent, 0o755);

  const existing = await fs.lstat(stagedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.uid !== uid)) {
    throw new Error(`Unsafe helper directory: ${stagedPath}`);
  }

  try {
    await syncBundle(Boolean(existing));
  } catch (error) {
    if (!existing) throw error;
    try {
      await verify(stagedPath);
      await makeReadable(stagedPath);
    } catch (cause) {
      throw new Error(`${error} (existing copy: ${cause})`);
    }
    log.warn(
      `Could not stage the Computer Use helper. Using the signed copy at ${stagedPath}: ${error}`,
    );
  }

  const now = Date.now();
  for (const name of await fs.readdir(parent)) {
    if (!name.startsWith(stagingPrefix) && !name.startsWith(backupPrefix)) continue;
    const entryPath = join(parent, name);
    try {
      const info = await fs.lstat(entryPath);
      if (info.isDirectory() && info.uid === uid && now - info.mtimeMs >= staleCleanupMs) {
        await fs.rm(entryPath, { recursive: true, force: true });
      }
    } catch (error) {
      log.warn(`Could not clean up ${entryPath}: ${error}`);
    }
  }

  if (templatePath !== stagedPath) {
    await execFile(lsregister, ["-u", templatePath]).catch((error) =>
      log.warn(`lsregister -u ${templatePath}: ${error}`),
    );
  }
  await execFile(lsregister, ["-f", stagedPath]);
  return true;
}
