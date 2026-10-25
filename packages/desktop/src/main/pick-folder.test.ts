import { homedir } from "node:os";
import { describe, expect, it, rs } from "@rstest/core";
import type { OpenDialogOptions } from "electron";
import { pickFolder } from "./pick-folder";

function dialog(result: { canceled: boolean; filePaths: string[] }) {
  return rs.fn(async (_window: unknown, _options: OpenDialogOptions) => result);
}

describe("pickFolder", () => {
  it("returns the chosen folder with the home folder", async () => {
    const show = dialog({ canceled: false, filePaths: ["/Users/ray/code/rome"] });
    await expect(pickFolder(show, null, undefined)).resolves.toEqual({
      path: "/Users/ray/code/rome",
      home: homedir(),
    });
    expect(show).toHaveBeenCalledWith(null, { properties: ["openDirectory", "createDirectory"] });
  });

  it("returns null when the user cancels", async () => {
    await expect(pickFolder(dialog({ canceled: true, filePaths: [] }), null, "/tmp")).resolves.toBe(
      null,
    );
  });

  it("opens at an absolute start folder and ignores anything else", async () => {
    const show = dialog({ canceled: true, filePaths: [] });
    await pickFolder(show, null, "/Users/ray/code");
    await pickFolder(show, null, "code");
    await pickFolder(show, null, 42);
    expect(show.mock.calls.map((call) => call[1].defaultPath)).toEqual([
      "/Users/ray/code",
      undefined,
      undefined,
    ]);
  });
});
