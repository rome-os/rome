import { existsSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";
import { z } from "zod";
import { handleTrusted } from "./ipc-trust";

const pane = z.enum(["accessibility", "screenRecording"]);
export type ComputerUsePane = z.infer<typeof pane>;

const panes: Record<ComputerUsePane, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export function registerComputerUseSettings(helperPath: string, enabled: () => boolean) {
  // macOS permissions belong to the helper's identity. Reading them for Electron would
  // report Desktop's grants instead, so the status only checks the bundled executable.
  const helperPresent = () => existsSync(join(helperPath, "Contents", "MacOS", "RomeComputerUse"));
  const status = () => ({ enabled: enabled(), helperPresent: helperPresent() });
  const open = (pane: ComputerUsePane) => shell.openExternal(panes[pane]);
  const revealHelper = () => {
    if (helperPresent()) shell.showItemInFolder(helperPath);
  };

  handleTrusted("computerUse:status", status);
  handleTrusted("computerUse:openSettings", (_event, value) => open(pane.parse(value)));
  handleTrusted("computerUse:revealHelper", revealHelper);
  return { status, open, revealHelper };
}
