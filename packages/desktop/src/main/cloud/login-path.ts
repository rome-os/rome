import { execFile } from "child_process";

const MARK = "__ROME_LOGIN_PATH__";
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * The PATH of the user's login shell. A Mac app opened from Finder or the Dock
 * gets launchd's PATH, which holds only the system directories, so programs
 * Rome runs here would not find Homebrew, git, or node. Null when the shell
 * fails or takes longer than the timeout.
 */
export function loginShellPath(
  shell = process.env.SHELL,
  timeoutMs = 3000,
): Promise<string | null> {
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    // The markers separate PATH from anything the shell's startup files print.
    execFile(
      shell,
      ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`],
      { timeout: timeoutMs, encoding: "utf8" },
      (_error, stdout) => {
        const match = new RegExp(`${MARK}(.+?)${MARK}`, "s").exec(stdout ?? "");
        resolve(match ? match[1] : null);
      },
    );
  });
}

/** The current PATH with the Homebrew directories in front when it lacks them. */
export function withHomebrewDirs(path: string): string {
  const dirs = path.split(":").filter(Boolean);
  return [...FALLBACK_DIRS.filter((dir) => !dirs.includes(dir)), ...dirs].join(":");
}

/** Gives this process, and the programs it starts, the user's PATH. */
export async function adoptLoginShellPath(): Promise<void> {
  process.env.PATH = (await loginShellPath()) ?? withHomebrewDirs(process.env.PATH ?? "");
}
