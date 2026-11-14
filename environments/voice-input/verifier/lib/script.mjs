// The script: 20 recorded messages and the long message, built by script/build.py.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SCRIPT_DIR = join(homedir(), ".rome-environments/voice-input/script");

/**
 * The manifest in `dir`, with each recording's absolute path as `path`. Times are seconds
 * from the start of the recording. Throws when the manifest is missing, so a run never scores
 * against a script it cannot play.
 */
export function loadScript(dir = DEFAULT_SCRIPT_DIR) {
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) {
    throw new Error(
      `no script in ${dir}; build it with: nix-shell script/shell.nix --run "python3 -I script/build.py ${dir}"`,
    );
  }
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const withPath = (m) => ({ ...m, path: join(dir, m.wav) });
  return {
    dir,
    sources: manifest.sources,
    messages: manifest.messages.map(withPath),
    long: manifest.long ? withPath(manifest.long) : null,
    // Rule 4's long messages: set A's real speech, and set B's synthesized one when built.
    longs: [
      manifest.long && { set: "A", ...manifest.long },
      manifest.longB && { set: "B", ...manifest.longB },
    ]
      .filter(Boolean)
      .map(withPath),
  };
}

/** The browser language a message is spoken in. */
export function browserLanguage(message) {
  return message.language === "en" ? "en" : "zh-CN";
}
