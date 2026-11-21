import { join } from "node:path";
import { isRecord } from "@rome-os/node-core";
import { readPrivateJson } from "@rome-os/node-core/storage";

export const WEB_CONFIG_FILE = "web-config.json";

export async function readHostExecutionEnabled(configDirectory: string): Promise<boolean> {
  const raw = await readPrivateJson(join(configDirectory, WEB_CONFIG_FILE));
  if (isRecord(raw) && raw.executionEnabled === false) return false;
  return true;
}
