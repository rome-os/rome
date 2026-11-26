import { existsSync } from "node:fs";
import { ipcMain, shell } from "electron";
import { expect, it, rs } from "@rstest/core";
import { registerComputerUseSettings } from "./computer-use-settings";

rs.mock("node:fs", () => ({ existsSync: rs.fn() }));
rs.mock("electron", () => ({
  ipcMain: { handle: rs.fn() },
  shell: { openExternal: rs.fn(), showItemInFolder: rs.fn() },
}));

it("checks the bundle passively and opens only fixed privacy panes from app pages", async () => {
  const helperPath = "/Rome.app/Contents/Resources/native/Rome Computer Use.app";
  registerComputerUseSettings(helperPath, () => false);
  const handlers = new Map(rs.mocked(ipcMain.handle).mock.calls);
  const status = handlers.get("computerUse:status")!;
  const open = handlers.get("computerUse:openSettings")!;
  const reveal = handlers.get("computerUse:revealHelper")!;
  const from = (url: string) => ({ senderFrame: { url } }) as never;
  const app = from("file:///Rome.app/settings.html");

  for (const handler of [status, open, reveal]) {
    expect(() => handler(from("https://rome.example/settings"), "accessibility")).toThrow(
      "is not available to this page",
    );
  }
  rs.mocked(existsSync).mockReturnValue(false);
  expect(status(app)).toEqual({ enabled: false, helperPresent: false });
  reveal(app);
  expect(shell.showItemInFolder).not.toHaveBeenCalled();
  rs.mocked(existsSync).mockReturnValue(true);
  expect(status(app)).toEqual({ enabled: false, helperPresent: true });
  expect(existsSync).toHaveBeenCalledWith(`${helperPath}/Contents/MacOS/RomeComputerUse`);
  expect(() => open(app, "https://example.com")).toThrow();
  expect(shell.openExternal).not.toHaveBeenCalled();

  await open(app, "accessibility");
  await open(app, "screenRecording");
  expect(shell.openExternal).toHaveBeenNthCalledWith(
    1,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  );
  expect(shell.openExternal).toHaveBeenNthCalledWith(
    2,
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
  reveal(app);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(helperPath);
});
