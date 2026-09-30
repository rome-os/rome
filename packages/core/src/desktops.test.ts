import { describe, expect, it } from "@rstest/core";
import { desktopSlot } from "./desktops.js";

const wechatOn = { WECHAT_USER_ENABLED: "true", DISPLAY: ":99", WECHAT_USER_DISPLAY: ":100" };

describe("desktopSlot", () => {
  it("gives wechat its display and default ports", () => {
    expect(desktopSlot("wechat", wechatOn)).toEqual({
      display: ":100",
      vncPort: 5901,
      novncPort: 6081,
    });
  });

  it("takes wechat's ports from the legacy variables", () => {
    expect(
      desktopSlot("wechat", {
        ...wechatOn,
        WECHAT_USER_DISPLAY: ":120",
        ROME_WECHAT_VNC_PORT: "5950",
        ROME_WECHAT_NOVNC_PORT: "6150",
      }),
    ).toEqual({ display: ":120", vncPort: 5950, novncPort: 6150 });
  });

  it("has no wechat desktop while WeChat is disabled, has no display, or has an invalid one", () => {
    expect(desktopSlot("wechat", { ...wechatOn, WECHAT_USER_ENABLED: "false" })).toBeNull();
    expect(desktopSlot("wechat", { ...wechatOn, WECHAT_USER_DISPLAY: "" })).toBeNull();
    expect(desktopSlot("wechat", { ...wechatOn, WECHAT_USER_DISPLAY: ":99" })).toBeNull();
  });

  it("has no desktop for a name outside the table", () => {
    for (const name of ["notes", "Wechat", "websockify", "__proto__", "constructor"]) {
      expect(desktopSlot(name, wechatOn)).toBeNull();
    }
  });
});
