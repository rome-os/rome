import { existsSync } from "node:fs";
import { shell } from "electron";
import { expect, it, rs } from "@rstest/core";
import { createComputerUseSettings } from "./computer-use-settings";

rs.mock("node:fs", () => ({ existsSync: rs.fn() }));
rs.mock("electron", () => ({
  shell: { openExternal: rs.fn(), showItemInFolder: rs.fn() },
}));

const helperPath = "/Rome.app/Contents/Resources/native/Rome Computer Use.app";

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
  revealHelper();
  expect(shell.showItemInFolder).toHaveBeenCalledWith(helperPath);
});

it("opens the selected macOS privacy pane", async () => {
  const { open } = createComputerUseSettings(helperPath, () => false);
  await open("accessibility");
  await open("screenRecording");
  expect(shell.openExternal).toHaveBeenNthCalledWith(
    1,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  );
  expect(shell.openExternal).toHaveBeenNthCalledWith(
    2,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
});
