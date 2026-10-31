import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Where builds that ran a private VM kept it: the VM disk and the Rome home
 * with its chats, memory and CLI logins. The app no longer opens, stops or
 * deletes anything here; it only tells the user the folder is still there.
 * Null when this computer never had one.
 */
export function legacyRuntimeDir(home = homedir()): string | null {
  const dir = join(home, ".rome-desktop", "runtime");
  return existsSync(dir) ? dir : null;
}
