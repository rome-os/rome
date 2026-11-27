import { existsSync } from "node:fs";
import { launchPermissionSetup } from "@rome-os/node-core/host";
import { shell } from "electron";
import { beforeEach, expect, it, rs } from "@rstest/core";
import { createComputerUseSettings } from "./computer-use-settings";

rs.mock("node:fs", () => ({ existsSync: rs.fn() }));
rs.mock("@rome-os/node-core/host", () => ({ launchPermissionSetup: rs.fn() }));
rs.mock("electron", () => ({
  shell: { openExternal: rs.fn(), showItemInFolder: rs.fn() },
}));

const helperPath = "/Users/test/.rome/computer-use/Rome Computer Use.app";

beforeEach(() => {
  rs.resetAllMocks();
});

it("reads the preference and bundle status passively and reveals an installed helper", () => {
  let enabled = false;
  const { status, revealHelper } = createComputerUseSettings(helperPath, () => enabled);

  rs.mocked(existsSync).mockReturnValue(false);
  expect(status()).toEqual({ enabled: false, helperPresent: false });
  revealHelper();
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  enabled = true;
  rs.mocked(existsSync).mockReturnValue(true);
  expect(status()).toEqual({ enabled: true, helperPresent: true });
  expect(existsSync).toHaveBeenCalledWith(`${helperPath}/Contents/MacOS/RomeComputerUse`);
  expect(shell.openExternal).not.toHaveBeenCalled();
  expect(launchPermissionSetup).not.toHaveBeenCalled();
  revealHelper();
  expect(shell.showItemInFolder).toHaveBeenCalledWith(helperPath);
});

it("opens the same native guide for full and focused setup", async () => {
  rs.mocked(existsSync).mockReturnValue(true);
  const { setup, open } = createComputerUseSettings(helperPath, () => false);
  await setup();
  await open("accessibility");
  await open("screenRecording");
  expect(launchPermissionSetup).toHaveBeenNthCalledWith(1, { appPath: helperPath });
  expect(launchPermissionSetup).toHaveBeenNthCalledWith(2, {
    appPath: helperPath,
    pane: "accessibility",
  });
  expect(launchPermissionSetup).toHaveBeenNthCalledWith(3, {
    appPath: helperPath,
    pane: "screen-recording",
  });
  expect(shell.openExternal).not.toHaveBeenCalled();
});

it("opens the macOS privacy pane when the helper is missing or fails to launch", async () => {
  const { setup, open } = createComputerUseSettings(helperPath, () => false);
  rs.mocked(existsSync).mockReturnValue(false);
  await setup();
  await open("accessibility");
  expect(launchPermissionSetup).not.toHaveBeenCalled();
  rs.mocked(existsSync).mockReturnValue(true);
  rs.mocked(launchPermissionSetup).mockRejectedValueOnce(new Error("signature failed"));
  await setup();
  rs.mocked(launchPermissionSetup).mockRejectedValueOnce(new Error("LaunchServices failed"));
  await open("screenRecording");
  expect(launchPermissionSetup).toHaveBeenCalledTimes(2);
  expect(shell.openExternal).toHaveBeenNthCalledWith(
    1,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  );
  expect(shell.openExternal).toHaveBeenNthCalledWith(
    2,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  );
  expect(shell.openExternal).toHaveBeenNthCalledWith(
    3,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  );
  expect(shell.openExternal).toHaveBeenNthCalledWith(
    4,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
});

it.each([
  "setup",
  "open",
  "revealHelper",
] as const)("repairs a deleted staged helper on %s", async (action) => {
  rs.mocked(existsSync).mockReturnValue(false);
  const ensureHelper = rs.fn(async () => {
    rs.mocked(existsSync).mockReturnValue(true);
    return true;
  });
  const settings = createComputerUseSettings(helperPath, () => true, { ensureHelper });
  expect(settings.status().helperPresent).toBe(false);
  expect(ensureHelper).not.toHaveBeenCalled();
  if (action === "open") await settings.open("screenRecording");
  else await settings[action]();
  expect(ensureHelper).toHaveBeenCalledTimes(1);
  if (action === "revealHelper") expect(shell.showItemInFolder).toHaveBeenCalledWith(helperPath);
  else
    expect(launchPermissionSetup).toHaveBeenCalledWith(
      action === "setup"
        ? { appPath: helperPath }
        : { appPath: helperPath, pane: "screen-recording" },
    );
  expect(shell.openExternal).not.toHaveBeenCalled();
});

it("keeps a rejected staged bundle unavailable when repair fails", async () => {
  rs.mocked(existsSync).mockReturnValue(true);
  const settings = createComputerUseSettings(helperPath, () => true, {
    helperReady: () => false,
    ensureHelper: async () => {
      throw new Error("unsafe directory");
    },
  });
  expect(settings.status().helperPresent).toBe(false);
  await settings.revealHelper();
  await settings.open("screenRecording");
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  expect(launchPermissionSetup).not.toHaveBeenCalled();
  expect(shell.openExternal).toHaveBeenCalledWith(expect.stringContaining("Privacy_ScreenCapture"));
});
