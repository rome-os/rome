import { systemPreferences } from "electron";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { readSelectedText, type MacText } from "./selection";

rs.mock("electron", () => ({
  systemPreferences: { isTrustedAccessibilityClient: rs.fn() },
}));
rs.mock("../logger", () => ({
  createLogger: () => ({ info: rs.fn(), warn: rs.fn() }),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform");

/** A fake Mac whose clipboard holds `clipboard` and whose ⌘C copies `copied`. */
function fakeMac(selected: string | null, copied: string | null, clipboard = "what you had") {
  const board = { text: clipboard as string | null, count: 1 };
  const snapshots: Array<{ restore: ReturnType<typeof rs.fn>; discard: ReturnType<typeof rs.fn> }> =
    [];
  const text: MacText = {
    selectedText: rs.fn(() => selected),
    pasteboardChangeCount: rs.fn(() => board.count),
    pasteboardString: rs.fn(() => board.text),
    snapshotPasteboard: rs.fn(() => {
      const saved = board.text;
      const snapshot = {
        restore: rs.fn(() => {
          board.text = saved;
          board.count += 1;
        }),
        discard: rs.fn(),
      };
      snapshots.push(snapshot);
      return snapshot;
    }),
    pressCopy: rs.fn(() => {
      if (copied === null) return;
      board.text = copied;
      board.count += 1;
    }),
  };
  return { text, board, snapshots };
}

beforeEach(() => {
  rs.resetAllMocks();
  Object.defineProperty(process, "platform", { value: "darwin" });
  rs.mocked(systemPreferences.isTrustedAccessibilityClient).mockReturnValue(true);
});

describe("readSelectedText", () => {
  it("reads the selection through Accessibility and leaves the clipboard alone", async () => {
    const { text } = fakeMac("  serendipity ", "copied");
    expect(await readSelectedText(text)).toBe("serendipity");
    expect(text.pressCopy).not.toHaveBeenCalled();
    expect(text.snapshotPasteboard).not.toHaveBeenCalled();
  });

  it("does not press ⌘C when Accessibility answers that nothing is selected", async () => {
    const { text } = fakeMac("", "the current line");
    expect(await readSelectedText(text)).toBeNull();
    expect(text.pressCopy).not.toHaveBeenCalled();
  });

  it("copies the selection when Accessibility can't answer, then puts the clipboard back", async () => {
    const { text, board, snapshots } = fakeMac(null, "你好");
    expect(await readSelectedText(text)).toBe("你好");
    expect(text.pressCopy).toHaveBeenCalledOnce();
    expect(snapshots[0].restore).toHaveBeenCalledOnce();
    expect(board.text).toBe("what you had");
  });

  it("finds nothing selected when the copy changes nothing, and lets the snapshot go", async () => {
    const { text, snapshots } = fakeMac(null, null);
    expect(await readSelectedText(text)).toBeNull();
    expect(snapshots[0].restore).not.toHaveBeenCalled();
    expect(snapshots[0].discard).toHaveBeenCalledOnce();
  });

  it("runs one read at a time, so overlapping presses keep the user's clipboard", async () => {
    const { text, board } = fakeMac(null, "selection");
    const [first, second] = await Promise.all([readSelectedText(text), readSelectedText(text)]);
    expect([first, second]).toEqual(["selection", "selection"]);
    expect(text.pressCopy).toHaveBeenCalledOnce();
    expect(board.text).toBe("what you had");
    // The next press after the read finished reads again.
    await readSelectedText(text);
    expect(text.pressCopy).toHaveBeenCalledTimes(2);
  });

  it("puts the clipboard back when the copy fails midway", async () => {
    const { text, board, snapshots } = fakeMac(null, null);
    rs.mocked(text.pressCopy).mockImplementation(() => {
      board.text = "half copied";
      throw new Error("CGEventPost failed");
    });
    expect(await readSelectedText(text)).toBeNull();
    expect(snapshots[0].restore).toHaveBeenCalledOnce();
    expect(board.text).toBe("what you had");
  });

  it("asks for Accessibility instead of reading without it", async () => {
    rs.mocked(systemPreferences.isTrustedAccessibilityClient).mockReturnValue(false);
    const { text } = fakeMac("serendipity", null);
    expect(await readSelectedText(text)).toBeNull();
    expect(systemPreferences.isTrustedAccessibilityClient).toHaveBeenLastCalledWith(true);
    expect(text.selectedText).not.toHaveBeenCalled();
  });

  it("reads nothing off macOS", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(await readSelectedText(fakeMac("serendipity", null).text)).toBeNull();
    if (platform) Object.defineProperty(process, "platform", platform);
  });
});
