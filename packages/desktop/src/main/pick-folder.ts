import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from "electron";

/** A folder on this computer, with the home folder so the dashboard can show it as `~`. */
export interface PickedFolder {
  path: string;
  home: string;
}

type ShowOpenDialog = (
  window: BrowserWindow | null,
  options: OpenDialogOptions,
) => Promise<OpenDialogReturnValue>;

/**
 * Asks the user for a folder on this computer with the system's own dialog,
 * attached to `window` when there is one. Resolves null when the user cancels.
 * A `defaultPath` that is not an absolute path is ignored.
 */
export async function pickFolder(
  showOpenDialog: ShowOpenDialog,
  window: BrowserWindow | null,
  defaultPath: unknown,
): Promise<PickedFolder | null> {
  const start =
    typeof defaultPath === "string" && isAbsolute(defaultPath) ? defaultPath : undefined;
  const result = await showOpenDialog(window, {
    properties: ["openDirectory", "createDirectory"],
    ...(start ? { defaultPath: start } : {}),
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  return { path, home: homedir() };
}
