import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { APP_NAME } from "./launch.js";
import { ComputerUseError } from "./protocol.js";

interface DiscoveryOptions {
  platform: NodeJS.Platform;
  applications: string[];
  envPath?: string;
  bundledAppPath?: string;
}

function platformApp(): string | undefined {
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

export async function discoverHelper({
  platform = process.platform,
  applications = ["/Applications", join(homedir(), "Applications")],
  envPath = process.env.ROME_NODE_COMPUTER_USE_HELPER,
  bundledAppPath,
}: Partial<DiscoveryOptions> = {}): Promise<string> {
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

  if (envPath !== undefined) {
    const app = await installed(envPath);
    if (app) return app;
    throw new ComputerUseError("computer_use_helper_missing");
  }
  if (bundledAppPath !== undefined) {
    const app = await installed(bundledAppPath);
    if (app) return app;
  }
  const optionalApp = platformApp();
  if (optionalApp !== undefined) {
    const app = await installed(optionalApp);
    if (app) return app;
  }
  for (const directory of applications) {
    const app = await installed(join(directory, APP_NAME));
    if (app) return app;
  }
  throw new ComputerUseError("computer_use_helper_missing");
}
