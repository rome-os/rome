import { describe, expect, it } from "@rstest/core";
import { desktopSlot, startDesktopArgs, wechatUserDisplay } from "./desktops.js";

const wechatOn = { WECHAT_USER_ENABLED: "true", DISPLAY: ":99" };
const OPENBOX = "/opt/rome/scripts/docker/wechat-openbox-rc.xml";

describe("wechatUserDisplay", () => {
  it("names the legacy display only while WeChat is enabled with one set", () => {
    expect(wechatUserDisplay({ WECHAT_USER_ENABLED: "true", WECHAT_USER_DISPLAY: ":100" })).toBe(
      ":100",
    );
    expect(
      wechatUserDisplay({ WECHAT_USER_ENABLED: "false", WECHAT_USER_DISPLAY: ":100" }),
    ).toBeNull();
    expect(wechatUserDisplay({ WECHAT_USER_DISPLAY: ":100" })).toBeNull();
    expect(wechatUserDisplay({ WECHAT_USER_ENABLED: "true", WECHAT_USER_DISPLAY: "" })).toBeNull();
  });

  it.each(["100", "localhost:100", ":1a", ":99"])("rejects WECHAT_USER_DISPLAY=%s", (value) => {
    expect(() =>
      wechatUserDisplay({
        WECHAT_USER_ENABLED: "true",
        DISPLAY: ":99",
        WECHAT_USER_DISPLAY: value,
      }),
    ).toThrow("WECHAT_USER_DISPLAY must be a display like :100, other than :99");
  });
});

describe("desktopSlot", () => {
  it("gives wechat its own desktop whenever WeChat is enabled", () => {
    expect(desktopSlot("wechat", wechatOn)).toEqual({
      display: ":100",
      vncPort: 5901,
      novncPort: 6081,
      openboxConfig: OPENBOX,
    });
  });

  it("takes wechat's display and ports from the legacy variables", () => {
    expect(
      desktopSlot("wechat", {
        ...wechatOn,
        WECHAT_USER_DISPLAY: ":120",
        ROME_WECHAT_VNC_PORT: "5950",
        ROME_WECHAT_NOVNC_PORT: "6150",
      }),
    ).toEqual({ display: ":120", vncPort: 5950, novncPort: 6150, openboxConfig: OPENBOX });
  });

  it("has no wechat desktop while WeChat is disabled or its display is invalid", () => {
    expect(desktopSlot("wechat", { ...wechatOn, WECHAT_USER_ENABLED: "false" })).toBeNull();
    expect(desktopSlot("wechat", { ...wechatOn, WECHAT_USER_DISPLAY: ":99" })).toBeNull();
    expect(desktopSlot("wechat", { ...wechatOn, WECHAT_USER_DISPLAY: "100" })).toBeNull();
    expect(desktopSlot("wechat", { WECHAT_USER_ENABLED: "true", DISPLAY: ":100" })).toBeNull();
  });

  it.each([
    "abc",
    "0",
    "65536",
    "5901.5",
    "-1",
    " 5901x",
    // Forms Number() accepts but the start script's ^[0-9]+$ rejects.
    "0x170D",
    "5.9e3",
    " 5901",
    "5901 ",
  ])("has no wechat desktop when a port is %s", (value) => {
    expect(desktopSlot("wechat", { ...wechatOn, ROME_WECHAT_VNC_PORT: value })).toBeNull();
    expect(desktopSlot("wechat", { ...wechatOn, ROME_WECHAT_NOVNC_PORT: value })).toBeNull();
  });

  it("accepts the ends of the port range", () => {
    expect(
      desktopSlot("wechat", {
        ...wechatOn,
        ROME_WECHAT_VNC_PORT: "1",
        ROME_WECHAT_NOVNC_PORT: "65535",
      }),
    ).toMatchObject({ vncPort: 1, novncPort: 65535 });
  });

  it("has no desktop for a name outside the table", () => {
    for (const name of ["notes", "Wechat", "websockify", "__proto__", "constructor"]) {
      expect(desktopSlot(name, wechatOn)).toBeNull();
    }
  });
});

describe("startDesktopArgs", () => {
  it("passes the slot to the start script, with the Openbox config when there is one", () => {
    const slot = desktopSlot("wechat", wechatOn)!;
    expect(startDesktopArgs("wechat", slot)).toEqual(["wechat", ":100", "5901", "6081", OPENBOX]);
    expect(startDesktopArgs("notes", { display: ":101", vncPort: 5902, novncPort: 6082 })).toEqual([
      "notes",
      ":101",
      "5902",
      "6082",
    ]);
  });
});
