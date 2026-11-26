import { existsSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";

const panes = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;
export type ComputerUsePane = keyof typeof panes;

export function createComputerUseSettings(helperPath: string, enabled: () => boolean) {
  // macOS permissions belong to the helper's identity. Reading them for Electron would
  // report Desktop's grants instead, so the status only checks the bundled executable.
  const helperPresent = () => existsSync(join(helperPath, "Contents", "MacOS", "RomeComputerUse"));
  const status = () => ({ enabled: enabled(), helperPresent: helperPresent() });
  const open = (pane: ComputerUsePane) => shell.openExternal(panes[pane]);
  const revealHelper = () => {
    if (helperPresent()) shell.showItemInFolder(helperPath);
  };

  return { status, open, revealHelper };
}
