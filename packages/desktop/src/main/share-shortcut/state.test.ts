import { describe, expect, it } from "@rstest/core";
import {
  MAX_SHARED_TEXT,
  panelPosition,
  readShareShortcutApp,
  SHARE_SHORTCUT_KEY,
  shareUrl,
} from "./state";

const APP = {
  appId: "what-does-it-mean",
  name: "Clear Translate",
  url: "https://ray.romeos.cc/full/apps/what-does-it-mean/share",
  param: "text",
};

function settingsWith(value: string | null) {
  return { read: (key: string) => (key === SHARE_SHORTCUT_KEY ? value : null), write: () => {} };
}

describe("readShareShortcutApp", () => {
  it("reads the saved app", () => {
    expect(readShareShortcutApp(settingsWith(JSON.stringify(APP)))).toEqual(APP);
  });

  it("reads anything unusable as no app", () => {
    expect(readShareShortcutApp(settingsWith(null))).toBeNull();
    expect(readShareShortcutApp(settingsWith("not json"))).toBeNull();
    expect(readShareShortcutApp(settingsWith(JSON.stringify({ ...APP, url: "nope" })))).toBeNull();
  });
});

describe("shareUrl", () => {
  it("puts the selection in the page's parameter", () => {
    expect(shareUrl(APP, "  serendipity \n")).toBe(`${APP.url}?text=serendipity`);
    expect(new URL(shareUrl(APP, "你好 world")).searchParams.get("text")).toBe("你好 world");
  });

  it("opens the plain page when nothing is selected", () => {
    expect(shareUrl(APP, null)).toBe(APP.url);
    expect(shareUrl(APP, "   ")).toBe(APP.url);
  });

  it("cuts a passage down to what a URL can carry", () => {
    const url = new URL(shareUrl(APP, "a".repeat(MAX_SHARED_TEXT + 50)));
    expect(url.searchParams.get("text")).toHaveLength(MAX_SHARED_TEXT);
  });
});

describe("panelPosition", () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { width: 420, height: 560 };

  it("opens beside the pointer", () => {
    expect(panelPosition({ x: 100, y: 100 }, size, workArea)).toEqual({ x: 116, y: 116 });
  });

  it("stays on screen near the edges", () => {
    expect(panelPosition({ x: 1430, y: 890 }, size, workArea)).toEqual({ x: 1020, y: 340 });
    expect(panelPosition({ x: -500, y: 0 }, size, workArea)).toEqual({ x: 0, y: 25 });
  });
});
