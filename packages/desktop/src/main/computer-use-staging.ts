import { execFile as nodeExecFile } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import * as files from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  APP_NAME,
  type EnsureComputerUseHelper,
  hasStagedHelperDirectory,
  RELEASE_SIGNING_REQUIREMENT,
  stagedHelperPath,
} from "@rome-os/node-core/host";
import { parseCdhash } from "./app-shims/bundle";
import {
  darwinStagingFiles,
  directoryFlags,
  fileFlags,
  type StagingEntry,
  type StagingFiles,
} from "./computer-use-staging-fs";

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const stagingPrefix = ".Rome Computer Use.staging-";
const backupPrefix = ".Rome Computer Use.old-";
const executable = "Contents/MacOS/RomeComputerUse";

const execFileAsync = promisify(nodeExecFile);
const lockName = ".Rome Computer Use.lock";

interface StagingOptions {
  templatePath: string;
  stagedPath?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fs?: Pick<typeof files, "access" | "mkdir" | "mkdtemp" | "open" | "readdir"> & {
    lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  };
  execFile?: (
    tool: string,
    args: string[],
    options: { timeout: number; killSignal: "SIGKILL"; encoding: "utf8" },
  ) => Promise<{ stdout: string; stderr: string }>;
  commandTimeoutMs?: number;
  lockWaitMs?: number;
  stagingFiles?: StagingFiles;
  log: { warn(message: string): void; error(message: string): void };
}

// The kernel drops flock on process exit, even if the lock file survives a crash.
function tryLock(fd: number): boolean {
  const koffi = require("koffi") as typeof import("koffi");
  const flock = koffi.load(null).func("int flock(int fd, int operation)");
  if (flock(fd, 2 | 4) === 0) return true; // LOCK_EX | LOCK_NB
  const errno = koffi.errno();
  if (errno === koffi.os.errno.EWOULDBLOCK) return false;
  throw new Error(`Cannot lock helper staging directory (errno ${errno})`);
}

function sameInode<T extends number | bigint>(
  first: { dev: T; ino: T },
  second: { dev: T; ino: T } | undefined,
) {
  return second !== undefined && first.dev === second.dev && first.ino === second.ino;
}

export function createStagedComputerUseHelper(options: StagingOptions & { stagedPath: string }) {
  let stagedReady = false;
  const helperReady = () =>
    stagedReady &&
    hasStagedHelperDirectory(options.stagedPath) &&
    existsSync(join(options.stagedPath, executable)) &&
    existsSync(join(options.stagedPath, "Contents/Info.plist"));
  const ensureHelper: EnsureComputerUseHelper = async (callOptions) => {
    if (!callOptions?.force && helperReady()) return true;
    // A copied executable can appear before its permissions and registration are ready.
    stagedReady = false;
    stagedReady = await stageComputerUseHelper(options);
    return stagedReady;
  };
  return { ensureHelper, helperReady };
}

// Requests in the same process also share the result of the current repair.
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
  const { templatePath, log, fs = files } = options;
  const parent = dirname(stagedPath);
  const root = dirname(parent);
  const appName = basename(stagedPath);
  const at = options.stagingFiles ?? darwinStagingFiles();
  const uid = process.getuid!();
  const parents: { path: string; handle: files.FileHandle; info: BigIntStats }[] = [];

  function execFile(tool: string, args: string[]) {
    return (options.execFile ?? execFileAsync)(tool, args, {
      timeout: options.commandTimeoutMs ?? (tool === "/usr/bin/ditto" ? 30_000 : 15_000),
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
  }

  async function ownedDirectory(path: string) {
    const info = await fs.lstat(path, { bigint: true });
    if (!info.isDirectory() || info.uid !== BigInt(uid))
      throw new Error(`Unsafe helper directory: ${path}`);
    return info;
  }

  async function checkParents() {
    for (const { path, info } of parents) {
      if (!sameInode(info, await ownedDirectory(path)))
        throw new Error(`Helper directory changed: ${path}`);
    }
  }

  function protectPrivateSiblings(rootFd: number) {
    for (const name of at.names(rootFd)) {
      if (name === basename(parent)) continue;
      const entry = at.statAt(rootFd, name);
      if (!entry) continue;
      const kind = entry.mode & constants.S_IFMT;
      if (kind === constants.S_IFLNK || (entry.mode & 0o077) === 0) continue;
      if (entry.uid !== uid || (kind !== constants.S_IFDIR && kind !== constants.S_IFREG)) {
        throw new Error(`Cannot protect private entry before widening ${root}: ${name}`);
      }
      const fd = at.openAt(rootFd, name, kind === constants.S_IFDIR ? directoryFlags : fileFlags);
      try {
        const info = fstatSync(fd, { bigint: true });
        if (
          !sameInode(entry, info) ||
          info.uid !== BigInt(uid) ||
          (Number(info.mode) & constants.S_IFMT) !== kind
        )
          throw new Error(`Private entry changed: ${name}`);
        fchmodSync(fd, Number(info.mode) & 0o700);
      } finally {
        closeSync(fd);
      }
    }
  }

  async function setParentMode(path: string, handle: files.FileHandle) {
    const { mode } = await handle.stat();
    if ((mode & 0o7777) === 0o755) return;
    // Direct siblings may rely on the root directory for privacy.
    if (path === root && (mode & 0o055) !== 0o055) protectPrivateSiblings(handle.fd);
    await handle.chmod(0o755);
  }

  async function setMode(path: string, directory: boolean) {
    const handle = await fs.open(path, directory ? directoryFlags : fileFlags);
    try {
      const info = await handle.stat();
      if (
        info.uid !== uid ||
        (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      ) {
        throw new Error(`Unsafe helper bundle entry: ${path}`);
      }
      const mode = directory ? 0o755 : 0o644;
      if ((info.mode & 0o7777) !== mode) await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }

  async function withLock(parentFd: number) {
    const deadline = performance.now() + (options.lockWaitMs ?? 10_000);
    let backoff = 25;
    do {
      await checkParents();
      const fd = at.openAt(
        parentFd,
        lockName,
        constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = fstatSync(fd, { bigint: true });
        // A previous holder may have unlinked this inode after we opened it.
        if (info.nlink !== 0n) {
          if (
            !info.isFile() ||
            info.nlink !== 1n ||
            info.uid !== BigInt(uid) ||
            (info.mode & 0o7777n) !== 0o600n
          )
            throw new Error(`Unsafe helper staging lock: ${lockName}`);
          if (tryLock(fd) && sameInode(info, at.statAt(parentFd, lockName))) {
            try {
              ftruncateSync(fd, 0);
              writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
              return await stageLocked(parentFd);
            } finally {
              if (sameInode(info, at.statAt(parentFd, lockName)))
                at.unlinkAt(parentFd, lockName, false);
            }
          }
        }
      } finally {
        closeSync(fd);
      }
      await delay(Math.min(backoff, Math.max(0, deadline - performance.now())));
      backoff = Math.min(backoff * 2, 250);
    } while (performance.now() < deadline);
    throw new Error(`Timed out waiting for ${join(parent, lockName)}`);
  }

  async function makeReadable(app: string) {
    await checkParents();
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
      if (!(await fs.lstat(directory, { bigint: true })).isDirectory())
        throw new Error(`Invalid helper: ${directory}`);
    }
    const binary = join(app, executable);
    if (!(await fs.lstat(binary, { bigint: true })).isFile())
      throw new Error(`Invalid helper executable: ${binary}`);
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

  function removeDirectory(dirFd: number, name: string, entry = at.statAt(dirFd, name)) {
    if (!entry || (entry.mode & constants.S_IFMT) !== constants.S_IFDIR || entry.uid !== uid)
      return;
    const childFd = at.openAt(dirFd, name, directoryFlags);
    try {
      const info = fstatSync(childFd, { bigint: true });
      if (!info.isDirectory() || info.uid !== BigInt(uid) || !sameInode(info, entry))
        throw new Error(`Unsafe helper directory: ${name}`);
      for (const child of at.names(childFd)) {
        const stat = at.statAt(childFd, child);
        if (!stat) continue;
        if ((stat.mode & constants.S_IFMT) === constants.S_IFDIR)
          removeDirectory(childFd, child, stat);
        else at.unlinkAt(childFd, child, false);
      }
      if (sameInode(info, at.statAt(dirFd, name))) at.unlinkAt(dirFd, name, true);
    } finally {
      closeSync(childFd);
    }
  }

  function bundleAt(fd: number, name: string) {
    const entry = at.statAt(fd, name);
    if (entry && ((entry.mode & constants.S_IFMT) !== constants.S_IFDIR || entry.uid !== uid))
      throw new Error(`Unsafe helper directory: ${name}`);
    return entry;
  }

  async function checkBundlePath(path: string, entry: StagingEntry) {
    if (!sameInode(entry, await ownedDirectory(path)))
      throw new Error(`Helper directory changed: ${path}`);
  }

  async function syncBundle(parentFd: number, existing: StagingEntry | undefined) {
    const template = await identity(templatePath);
    const matches = (other: typeof template) =>
      other.cdhash === template.cdhash &&
      other.build === template.build &&
      other.version === template.version;
    if (existing && (await identity(stagedPath).then(matches, () => false))) {
      await checkBundlePath(stagedPath, existing);
      if (
        await makeReadable(stagedPath).then(
          () => true,
          () => false,
        )
      ) {
        return existing;
      }
    }
    await checkParents();
    const tempDir = await fs.mkdtemp(join(parent, stagingPrefix));
    const tempName = basename(tempDir);
    const tempDirFd = at.openAt(parentFd, tempName, directoryFlags);
    try {
      const tempInfo = fstatSync(tempDirFd, { bigint: true });
      if (
        !tempInfo.isDirectory() ||
        tempInfo.uid !== BigInt(uid) ||
        !sameInode(tempInfo, await ownedDirectory(tempDir))
      )
        throw new Error(`Unsafe helper directory: ${tempDir}`);
      try {
        const copy = join(tempDir, APP_NAME);
        await execFile("/usr/bin/ditto", [templatePath, copy]);
        const source = bundleAt(tempDirFd, APP_NAME);
        if (!source) throw new Error(`Missing copied helper: ${copy}`);
        await checkBundlePath(copy, source);
        await makeReadable(copy);
        if (!matches(await identity(copy)))
          throw new Error("Copied helper identity differs from the template");
        const verifiedCopy = bundleAt(tempDirFd, APP_NAME);
        if (!verifiedCopy || !sameInode(source, verifiedCopy))
          throw new Error(`Copied helper changed: ${copy}`);
        await checkBundlePath(copy, verifiedCopy);
        await checkParents();
        const destination = bundleAt(parentFd, appName);
        if (existing ? !sameInode(existing, destination) : destination)
          throw new Error(`Helper destination changed: ${stagedPath}`);
        at.publish(tempDirFd, APP_NAME, parentFd, appName, Boolean(existing));
        return verifiedCopy;
      } finally {
        try {
          const tempEntry = at.statAt(parentFd, tempName);
          if (sameInode(tempInfo, tempEntry)) removeDirectory(parentFd, tempName, tempEntry);
        } catch (error) {
          log.warn(`Could not clean up ${tempDir}: ${error}`);
        }
      }
    } finally {
      closeSync(tempDirFd);
    }
  }

  async function stageLocked(parentFd: number) {
    await checkParents();
    const existing = bundleAt(parentFd, appName);
    if (existing) await checkBundlePath(stagedPath, existing);
    let expectedStagedInode: StagingEntry;
    try {
      expectedStagedInode = await syncBundle(parentFd, existing);
    } catch (error) {
      if (!existing) throw error;
      try {
        await checkParents();
        await checkBundlePath(stagedPath, existing);
        await verify(stagedPath);
        await checkBundlePath(stagedPath, existing);
        for (const { path, handle } of parents) await setParentMode(path, handle);
        await makeReadable(stagedPath);
        expectedStagedInode = existing;
      } catch (cause) {
        throw new Error(`${error} (existing copy: ${cause})`);
      }
      log.warn(
        `Could not stage the Computer Use helper. Using the signed copy at ${stagedPath}: ${error}`,
      );
    }

    // A verified helper is in place and no other publisher can own a staging directory.
    await checkParents();
    for (const name of at.names(parentFd)) {
      if (name.startsWith(stagingPrefix) || name.startsWith(backupPrefix)) {
        try {
          removeDirectory(parentFd, name);
        } catch (error) {
          log.warn(`Could not clean up ${join(parent, name)}: ${error}`);
        }
      }
    }
    await checkParents();
    if (templatePath !== stagedPath) {
      await execFile(lsregister, ["-u", templatePath]).catch((error) =>
        log.warn(`lsregister -u ${templatePath}: ${error}`),
      );
    }
    await checkParents();
    if (!sameInode(expectedStagedInode, bundleAt(parentFd, appName)))
      throw new Error(`Helper destination changed: ${stagedPath}`);
    await execFile(lsregister, ["-f", stagedPath]);
    return true;
  }

  try {
    for (const path of [root, parent]) {
      await checkParents();
      await fs.mkdir(path, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const handle = await fs.open(path, directoryFlags);
      try {
        const info = await handle.stat({ bigint: true });
        if (!info.isDirectory() || info.uid !== BigInt(uid))
          throw new Error(`Unsafe helper directory: ${path}`);
        parents.push({ path, handle, info });
      } catch (error) {
        await handle.close();
        throw error;
      }
      await checkParents();
      await setParentMode(path, handle);
    }
    return await withLock(parents[1].handle.fd);
  } finally {
    await Promise.all(parents.map(({ handle }) => handle.close()));
  }
}
