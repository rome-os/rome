import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { APP_NAME } from "./launch.js";
import { ComputerUseError } from "./protocol.js";

export interface ComputerUseOptions {
  appPath?: string;
}

interface DiscoveryOptions {
  platform: NodeJS.Platform;
  applications: string[];
  envPath?: string;
}

export async function discoverHelper(
  options: ComputerUseOptions | undefined,
  {
    platform = process.platform,
    applications = ["/Applications", join(homedir(), "Applications")],
    envPath = process.env.ROME_NODE_COMPUTER_USE_HELPER,
  }: Partial<DiscoveryOptions> = {},
): Promise<string> {
  if (platform !== "darwin") throw new ComputerUseError("computer_use_unsupported_platform");

  async function installed(path: string): Promise<string | undefined> {
    if (!isAbsolute(path) || path.includes("\0")) {
      throw new ComputerUseError("invalid_helper_bundle");
    }
    try {
      if ((await stat(path)).isDirectory()) return path;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ComputerUseError("invalid_helper_bundle", { cause });
    }
    throw new ComputerUseError("invalid_helper_bundle");
  }

  const explicit = options?.appPath ?? envPath;
  if (explicit !== undefined) {
    const app = await installed(explicit);
    if (app) return app;
    throw new ComputerUseError("computer_use_helper_missing");
  }
  for (const directory of applications) {
    const app = await installed(join(directory, APP_NAME));
    if (app) return app;
  }
  throw new ComputerUseError("computer_use_helper_missing");
}
