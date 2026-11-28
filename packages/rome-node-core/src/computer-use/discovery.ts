import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { APP_NAME, stagedHelperPath, verifyHelperBundle } from "./launch.js";
import { ComputerUseError } from "./protocol.js";

interface DiscoveryOptions {
  platform: NodeJS.Platform;
  applications: string[];
  envPath?: string;
  bundledAppPath?: string;
  strictBundledAppPath?: boolean;
  stagedAppPath?: string | null;
  platformApp?: () => string | undefined;
}

export { stagedHelperPath };

export function hasStagedHelperDirectory(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const parent = dirname(path);
  const uid = process.getuid?.();
  try {
    return [parent, path].every((dir) => {
      const info = lstatSync(dir, { throwIfNoEntry: false });
      return info?.isDirectory() && (uid === undefined || info.uid === uid);
    });
  } catch {
    return false;
  }
}

function hasUsableStagedHelper(path: string): boolean {
  if (!hasStagedHelperDirectory(path)) return false;
  try {
    const contents = lstatSync(join(path, "Contents"), { throwIfNoEntry: false });
    const macOS = lstatSync(join(path, "Contents", "MacOS"), { throwIfNoEntry: false });
    const executable = join(path, "Contents", "MacOS", "RomeComputerUse");
    const binary = lstatSync(executable, { throwIfNoEntry: false });
    const plist = lstatSync(join(path, "Contents", "Info.plist"), { throwIfNoEntry: false });
    if (
      !contents?.isDirectory() ||
      !macOS?.isDirectory() ||
      !binary?.isFile() ||
      !plist?.isFile()
    ) {
      return false;
    }
    accessSync(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePlatformApp(): string | undefined {
  // esbuild replaces import.meta with an empty object in Desktop's CJS bundle.
  if (typeof import.meta.url !== "string") return;
  try {
    const manifest = createRequire(import.meta.url).resolve(
      "@rome-os/node-core-darwin-arm64/package.json",
    );
    return join(dirname(manifest), "dist", "native", APP_NAME);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
}

export function findInstalledHelper({
  platform = process.platform,
  applications = ["/Applications", join(homedir(), "Applications")],
  envPath = process.env.ROME_NODE_COMPUTER_USE_HELPER,
  bundledAppPath,
  stagedAppPath = stagedHelperPath(),
  platformApp = resolvePlatformApp,
}: Partial<Omit<DiscoveryOptions, "strictBundledAppPath">> = {}): string {
  if (platform !== "darwin") throw new ComputerUseError("computer_use_unsupported_platform");

  function installed(path: string): string | undefined {
    if (!isAbsolute(path) || path.includes("\0")) {
      throw new ComputerUseError("invalid_helper_bundle");
    }
    try {
      if (statSync(path).isDirectory()) return path;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ComputerUseError("invalid_helper_bundle", { cause });
    }
    throw new ComputerUseError("invalid_helper_bundle");
  }

  if (envPath !== undefined) {
    const app = installed(envPath);
    if (app) return app;
    throw new ComputerUseError("computer_use_helper_missing");
  }
  if (bundledAppPath !== undefined) {
    const app = installed(bundledAppPath);
    if (app) return app;
  }
  const optionalApp = platformApp();
  if (optionalApp !== undefined) {
    const app = installed(optionalApp);
    if (app) return app;
  }
  if (stagedAppPath !== null && hasUsableStagedHelper(stagedAppPath)) return stagedAppPath;
  for (const directory of applications) {
    const app = installed(join(directory, APP_NAME));
    if (app) return app;
  }
  throw new ComputerUseError("computer_use_helper_missing");
}

export async function discoverHelper(options: Partial<DiscoveryOptions> = {}): Promise<string> {
  if (!options.strictBundledAppPath) return findInstalledHelper(options);
  if ((options.platform ?? process.platform) !== "darwin")
    throw new ComputerUseError("computer_use_unsupported_platform");
  const { bundledAppPath } = options;
  if (!bundledAppPath || !hasStagedHelperDirectory(bundledAppPath)) {
    throw new ComputerUseError("computer_use_helper_missing");
  }
  try {
    await verifyHelperBundle(bundledAppPath, AbortSignal.timeout(5000));
    return bundledAppPath;
  } catch (cause) {
    throw new ComputerUseError("computer_use_helper_missing", { cause });
  }
}
