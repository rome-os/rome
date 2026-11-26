import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { APP_NAME } from "./launch.js";
import { ComputerUseError } from "./protocol.js";

interface DiscoveryOptions {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  applications: string[];
  envPath?: string;
}

export function canAutoInstallHelper({
  platform = process.platform,
  arch = process.arch,
  envPath = process.env.ROME_NODE_COMPUTER_USE_HELPER,
}: Partial<Pick<DiscoveryOptions, "platform" | "arch" | "envPath">> = {}): boolean {
  return platform === "darwin" && arch === "arm64" && envPath === undefined;
}

export async function discoverHelper({
  platform = process.platform,
  arch = process.arch,
  applications = ["/Applications", join(homedir(), "Applications")],
  envPath = process.env.ROME_NODE_COMPUTER_USE_HELPER,
}: Partial<DiscoveryOptions> = {}): Promise<string> {
  if (platform !== "darwin" || arch !== "arm64")
    throw new ComputerUseError("computer_use_unsupported_platform");

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

  if (envPath !== undefined) {
    const app = await installed(envPath);
    if (app) return app;
    throw new ComputerUseError("computer_use_helper_missing");
  }
  for (const directory of applications) {
    const app = await installed(join(directory, APP_NAME));
    if (app) return app;
  }
  throw new ComputerUseError("computer_use_helper_missing");
}
