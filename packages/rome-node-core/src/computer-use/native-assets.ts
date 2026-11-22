import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../actions.js";
import { ComputerUseError } from "./protocol.js";

const run = promisify(execFile);
const EXECUTABLE = "Contents/MacOS/RomeComputerUse";
export interface ComputerUseApp {
  path: string;
  executableSha256: string;
  implementationSha256: string;
  architecture: "arm64";
  requirement: string;
}

/** npm normalizes non-bin executable modes, so an archive's app is verified before staging. */
export async function inspectComputerUseApp(path: string): Promise<ComputerUseApp> {
  if (!isAbsolute(path))
    throw new ComputerUseError(
      "helper_not_installed",
      "The computer-use app path must be absolute.",
    );
  const [directory, executable] = await Promise.all([
    lstat(path).catch(() => null),
    lstat(join(path, EXECUTABLE)).catch(() => null),
  ]);
  if (
    !directory?.isDirectory() ||
    directory.isSymbolicLink() ||
    !executable?.isFile() ||
    executable.isSymbolicLink()
  )
    throw new ComputerUseError(
      "helper_not_installed",
      "The signed Rome Computer Use app is not installed.",
    );
  let signature: string;
  try {
    await run("/usr/bin/codesign", ["--verify", "--strict", path]);
    const result = await run("/usr/bin/codesign", [
      "--display",
      "--verbose=4",
      "--requirements",
      "-",
      path,
    ]);
    signature = result.stdout + result.stderr;
  } catch {
    throw new ComputerUseError(
      "helper_signature_invalid",
      "The computer-use app needs a valid stable Apple signing identity.",
    );
  }
  const requirement = signature.match(/^designated => (.+)$/m)?.[1];
  if (
    !/^Identifier=com\.rome\.computer-use$/m.test(signature) ||
    !/^Authority=(Apple Development:|Developer ID Application:)/m.test(signature) ||
    !requirement
  )
    throw new ComputerUseError(
      "helper_signature_invalid",
      "The computer-use app has an unexpected identity.",
    );
  let implementation: unknown;
  try {
    implementation = JSON.parse(
      await readFile(join(path, "Contents/Resources/implementation.json"), "utf8"),
    );
  } catch {
    throw new ComputerUseError(
      "helper_update_required",
      "The computer-use app has no signed implementation identity. Rebuild the helper.",
    );
  }
  if (
    !isRecord(implementation) ||
    implementation.protocolVersion !== 1 ||
    implementation.architecture !== "arm64" ||
    typeof implementation.implementationSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(implementation.implementationSha256)
  )
    throw new ComputerUseError(
      "helper_update_required",
      "The computer-use app has an unsupported implementation identity.",
    );
  if (
    !isRecord(implementation.buildOptions) ||
    implementation.buildOptions.selfTest !== false ||
    implementation.buildOptions.unsigned !== false
  )
    throw new ComputerUseError(
      "helper_signature_invalid",
      "A CI or self-test helper cannot provide runtime computer use.",
    );
  const executableBytes = await readFile(join(path, EXECUTABLE));
  if (
    executableBytes.length < 32 ||
    executableBytes.readUInt32LE(0) !== 0xfeedfacf ||
    executableBytes.readUInt32LE(4) !== 0x0100000c
  )
    throw new ComputerUseError(
      "helper_architecture_mismatch",
      "The computer-use executable must be a macOS arm64 binary.",
    );
  return {
    path,
    requirement,
    implementationSha256: implementation.implementationSha256,
    architecture: "arm64",
    executableSha256: createHash("sha256").update(executableBytes).digest("hex"),
  };
}

/** Installs only local bundled bytes. The signed installer takes the native service's process lock. */
export async function prepareComputerUseApp(
  source: ComputerUseApp,
  stateDir: string,
): Promise<ComputerUseApp> {
  const directory = await lstat(stateDir);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new ComputerUseError(
      "unsafe_state_directory",
      "Computer-use assets require an owner-only state directory.",
    );
  stateDir = await realpath(stateDir);
  const target = join(stateDir, "Rome Computer Use.app");
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid?.())
      throw new ComputerUseError(
        "unsafe_helper_installation",
        "The existing computer-use app is not owned by this user.",
      );
    const installed = await inspectComputerUseApp(target);
    if (installed.requirement !== source.requirement)
      throw new ComputerUseError(
        "helper_identity_changed",
        "The helper signing identity changed. The existing authorized app was preserved.",
      );
    if (installed.implementationSha256 === source.implementationSha256) {
      const mode = (await lstat(join(target, EXECUTABLE))).mode;
      if ((mode & 0o111) !== 0o111)
        throw new ComputerUseError(
          "helper_installation_invalid",
          "The installed helper executable permissions are invalid.",
        );
      return installed;
    }
  }
  const stagingDirectory = join(stateDir, ".staging-" + randomUUID());
  await mkdir(stagingDirectory, { mode: 0o700 });
  const staging = join(stagingDirectory, "Rome Computer Use.app");
  try {
    await cp(source.path, staging, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
    });
    const executable = join(staging, EXECUTABLE);
    const mode = (await lstat(executable)).mode & 0o777;
    await chmod(executable, mode | 0o111);
    const candidate = await inspectComputerUseApp(staging);
    if (
      candidate.executableSha256 !== source.executableSha256 ||
      candidate.requirement !== source.requirement ||
      candidate.implementationSha256 !== source.implementationSha256
    )
      throw new ComputerUseError(
        "helper_asset_changed",
        "The computer-use app changed while it was being prepared.",
      );
    try {
      await run(executable, ["--install-staged-app", "--state-dir", stateDir], { timeout: 10_000 });
    } catch (error) {
      const busy =
        isRecord(error) &&
        typeof error.stderr === "string" &&
        /helper_already_running|helper_busy|helper_install_busy|helper_running_install_refused/.test(
          error.stderr,
        );
      throw new ComputerUseError(
        busy ? "helper_install_busy" : "helper_install_failed",
        "The native helper could not install its verified app. No running helper was replaced.",
      );
    }
    const installed = await inspectComputerUseApp(target);
    if (
      installed.executableSha256 !== source.executableSha256 ||
      installed.requirement !== source.requirement
    )
      throw new ComputerUseError(
        "helper_asset_changed",
        "The installed computer-use app does not match the verified asset.",
      );
    return installed;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
