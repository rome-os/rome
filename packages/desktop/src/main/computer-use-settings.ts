import { existsSync } from "node:fs";
import { join } from "node:path";
import { type EnsureComputerUseHelper, launchPermissionSetup } from "@rome-os/node-core/host";
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

export function createComputerUseSettings(
  helperPath: string | (() => string),
  enabled: () => boolean,
  options: { ensureHelper?: EnsureComputerUseHelper; helperReady?: () => boolean } = {},
) {
  // macOS permissions belong to the helper's identity. Reading them for Electron would
  // report Desktop's grants instead, so the status only reports helper availability.
  let ready = true;
  function presentPath() {
    if (!(options.helperReady?.() ?? ready)) return;
    try {
      const path = typeof helperPath === "string" ? helperPath : helperPath();
      if (existsSync(join(path, "Contents/MacOS/RomeComputerUse"))) return path;
    } catch {
      // Discovery can fail when an explicit development override is missing.
    }
  }
  const status = () => ({ enabled: enabled(), helperPresent: Boolean(presentPath()) });
  async function ensureReady(force = false) {
    try {
      ready = force ? await options.ensureHelper!({ force: true }) : await options.ensureHelper!();
    } catch {
      ready = false;
    }
    return ready;
  }
  const openGuided = async (pane?: ComputerUsePane) => {
    for (const force of [false, true]) {
      if (force && !options.ensureHelper) break;
      if (options.ensureHelper && !(await ensureReady(force))) break;
      const path = presentPath();
      if (!path) break;
      try {
        await launchPermissionSetup(
          pane ? { appPath: path, pane: panes[pane].setup } : { appPath: path },
        );
        return;
      } catch {
        // A signature failure can leave every file that the readiness check looks for.
      }
    }
    await shell.openExternal(panes[pane ?? "accessibility"].url);
  };
  const setup = () => openGuided();
  const open = (pane: ComputerUsePane) => openGuided(pane);
  const revealHelper = async () => {
    const path = (!options.ensureHelper || (await ensureReady())) && presentPath();
    if (path) shell.showItemInFolder(path);
  };

  return { status, setup, open, revealHelper };
}
