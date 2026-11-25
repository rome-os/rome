import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { APP_NAME, untilAbort, verifyHelperBundle } from "./launch.js";
import { ComputerUseError } from "./protocol.js";

export interface ComputerUseOptions {
  enabled: boolean;
  appPath?: string;
  /** Returns the absolute bundle path from an optional local installation, if present. */
  resolveAppPath?: () => string | undefined | Promise<string | undefined>;
}

interface DiscoveryOptions {
  platform: NodeJS.Platform;
  applications: string[];
  envPath?: string;
  verify: typeof verifyHelperBundle;
}

export async function discoverHelper(
  options: ComputerUseOptions | undefined,
  {
    platform = process.platform,
    applications = ["/Applications", join(homedir(), "Applications")],
    envPath = process.env.ROME_NODE_COMPUTER_USE_HELPER,
    verify = verifyHelperBundle,
  }: Partial<DiscoveryOptions> = {},
): Promise<string> {
  if (!options?.enabled) throw new ComputerUseError("computer_use_off");
  if (platform !== "darwin") throw new ComputerUseError("computer_use_unsupported_platform");

  async function installed(path: string): Promise<string | undefined> {
    if (!isAbsolute(path) || path.includes("\0")) {
      throw new ComputerUseError("invalid_helper_bundle");
    }
    try {
      await lstat(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ComputerUseError("invalid_helper_bundle", { cause });
    }
    return verify(path, AbortSignal.timeout(4_000));
  }

  const explicit = options.appPath ?? envPath;
  if (explicit !== undefined) {
    const app = await installed(explicit);
    if (app) return app;
    throw new ComputerUseError("computer_use_helper_missing");
  }
  for (const directory of applications) {
    const app = await installed(join(directory, APP_NAME));
    if (app) return app;
  }
  let optional: string | undefined;
  try {
    optional = await untilAbort(() => options.resolveAppPath?.(), AbortSignal.timeout(4_000));
  } catch (cause) {
    throw new ComputerUseError("invalid_helper_bundle", { cause });
  }
  const app = optional === undefined ? undefined : await installed(optional);
  if (!app) throw new ComputerUseError("computer_use_helper_missing");
  return app;
}
