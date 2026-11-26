import { existsSync } from "node:fs";
import { join } from "node:path";
import { launchPermissionSetup } from "@rome-os/node-core/host";
import { shell } from "electron";

const panes = {
  accessibility: {
    setup: "accessibility",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
  screenRecording: {
    setup: "screen-recording",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  },
} as const;
export type ComputerUsePane = keyof typeof panes;

export function createComputerUseSettings(helperPath: string, enabled: () => boolean) {
  // macOS permissions belong to the helper's identity. Reading them for Electron would
  // report Desktop's grants instead, so the status only checks the bundled executable.
  const helperPresent = () => existsSync(join(helperPath, "Contents", "MacOS", "RomeComputerUse"));
  const status = () => ({ enabled: enabled(), helperPresent: helperPresent() });
  const openGuided = async (pane?: ComputerUsePane) => {
    if (helperPresent()) {
      try {
        await launchPermissionSetup(
          pane ? { appPath: helperPath, pane: panes[pane].setup } : { appPath: helperPath },
        );
        return;
      } catch {
        // The privacy pane is still useful when the helper cannot launch.
      }
    }
    await shell.openExternal(panes[pane ?? "accessibility"].url);
  };
  const setup = () => openGuided();
  const open = (pane: ComputerUsePane) => openGuided(pane);
  const revealHelper = () => {
    if (helperPresent()) shell.showItemInFolder(helperPath);
  };

  return { status, setup, open, revealHelper };
}
