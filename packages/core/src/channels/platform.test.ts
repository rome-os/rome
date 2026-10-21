import { describe, expect, it } from "@rstest/core";
import { domainOf, platformOf } from "./platform.js";

describe("platformOf", () => {
  it("puts a Feishu app on Lark only when its domain is lark", () => {
    expect(platformOf("feishu", "lark")).toBe("lark");
    expect(platformOf("feishu", "feishu")).toBe("feishu");
    expect(platformOf("feishu")).toBe("feishu");
    expect(platformOf("feishu", null)).toBe("feishu");
  });

  it("counts a signed-in user on the platform of its bot, whatever the domain", () => {
    expect(platformOf("telegram_user")).toBe("telegram");
    expect(platformOf("wechat_user", "lark")).toBe("wechat");
    expect(platformOf("telegram", "lark")).toBe("telegram");
    expect(platformOf("discord")).toBe("discord");
  });
});

describe("domainOf", () => {
  it("reads a string domain and nothing else", () => {
    expect(domainOf({ appId: "cli_1", domain: "lark" })).toBe("lark");
    expect(domainOf({ domain: 1 })).toBeUndefined();
    expect(domainOf({})).toBeUndefined();
    expect(domainOf(undefined)).toBeUndefined();
  });
});
