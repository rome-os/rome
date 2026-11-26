import { clipboard, systemPreferences } from "electron";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { readSelectedText, type MacText } from "./selection";

rs.mock("electron", () => ({
  clipboard: { read: rs.fn(), readText: rs.fn(), write: rs.fn(), clear: rs.fn() },
  systemPreferences: { isTrustedAccessibilityClient: rs.fn() },
}));
rs.mock("../logger", () => ({
  createLogger: () => ({ info: rs.fn(), warn: rs.fn() }),
}));

// What the clipboard held before the shortcut; stands in for Electron's ClipboardItem.
const SAVED = [{ types: ["text/plain"] }] as never;

const platform = Object.getOwnPropertyDescriptor(process, "platform");

function macText(selected: string | null, copied: string | null): MacText {
  let count = 1;
  return {
    selectedText: rs.fn(() => selected),
    pasteboardChangeCount: rs.fn(() => count),
    pressCopy: rs.fn(() => {
      if (copied === null) return;
      count += 1;
      rs.mocked(clipboard.readText).mockResolvedValue(copied);
    }),
  };
}

beforeEach(() => {
  rs.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin" });
  rs.mocked(systemPreferences.isTrustedAccessibilityClient).mockReturnValue(true);
  rs.mocked(clipboard.read).mockResolvedValue(SAVED);
});

describe("readSelectedText", () => {
  it("reads the selection through Accessibility and leaves the clipboard alone", async () => {
    const text = macText("  serendipity ", null);
    expect(await readSelectedText(text)).toBe("serendipity");
    expect(text.pressCopy).not.toHaveBeenCalled();
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("copies the selection when Accessibility has none, then restores the clipboard", async () => {
    const text = macText(null, "你好");
    expect(await readSelectedText(text)).toBe("你好");
    expect(text.pressCopy).toHaveBeenCalledOnce();
    expect(clipboard.write).toHaveBeenCalledWith(SAVED);
  });

  it("empties the clipboard again when it was empty before the copy", async () => {
    rs.mocked(clipboard.read).mockResolvedValue([]);
    expect(await readSelectedText(macText(null, "serendipity"))).toBe("serendipity");
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.clear).toHaveBeenCalledOnce();
  });

  it("finds nothing selected when the copy changes nothing", async () => {
    const text = macText("", null);
    expect(await readSelectedText(text)).toBeNull();
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("asks for Accessibility instead of reading without it", async () => {
    rs.mocked(systemPreferences.isTrustedAccessibilityClient).mockReturnValue(false);
    const text = macText("serendipity", null);
    expect(await readSelectedText(text)).toBeNull();
    expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenLastCalledWith(true);
    expect(text.selectedText).not.toHaveBeenCalled();
  });

  it("reads nothing off macOS", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(await readSelectedText(macText("serendipity", null))).toBeNull();
    if (platform) Object.defineProperty(process, "platform", platform);
  });
});
