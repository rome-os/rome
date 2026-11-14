import { describe, expect, it } from "@rstest/core";
import type { ThreadContext } from "@rome-os/app-runtime";
import { narrowerAudience, turnAudience } from "./turn-audience.js";

const place = (overrides: Partial<ThreadContext>): ThreadContext => ({
  channel: "telegram",
  threadId: "t-1",
  ...overrides,
});

const guardianDm = { threadType: "private" as const, senderBondLevel: "guardian" };

describe("turnAudience", () => {
  it("reads a dashboard chat as private", () => {
    expect(turnAudience(place({ channel: "webchat", ...guardianDm }))).toBe("private");
  });

  it.each([
    "telegram",
    "telegram_user",
    "whatsapp",
    "discord",
    "wechat",
    "slack",
    "feishu",
    "lark",
  ])("reads the guardian's direct message on %s as private", (channel) => {
    expect(turnAudience(place({ channel, ...guardianDm }))).toBe("private");
  });

  it.each([
    "telegram",
    "whatsapp",
    "discord",
    "slack",
    "feishu",
  ])("reads a group on %s as shared, even when the guardian wrote", (channel) => {
    expect(turnAudience(place({ channel, threadType: "group", senderBondLevel: "guardian" }))).toBe(
      "shared",
    );
  });

  it.each([
    "inner-circle",
    "acquaintance",
    "stranger",
    undefined,
  ])("reads a direct message from someone who is not the guardian (%s) as shared", (senderBondLevel) => {
    expect(turnAudience(place({ threadType: "private", senderBondLevel }))).toBe("shared");
  });

  it("reads an email thread as shared, though Rome marks it private", () => {
    expect(turnAudience(place({ channel: "email", ...guardianDm }))).toBe("shared");
  });

  it("fails closed for an unknown channel, a missing thread type and no place at all", () => {
    expect(turnAudience(place({ channel: "telegram-2", ...guardianDm }))).toBe("shared");
    expect(turnAudience(place({ senderBondLevel: "guardian" }))).toBe("shared");
    expect(turnAudience(undefined)).toBe("shared");
  });

  it("reads a turn that acts for a visitor as shared, even in a dashboard chat", () => {
    expect(
      turnAudience(place({ channel: "webchat", ...guardianDm }), { actor: { kind: "visitor" } }),
    ).toBe("shared");
    expect(
      turnAudience(place({ channel: "webchat", ...guardianDm }), { actor: { kind: "guardian" } }),
    ).toBe("private");
  });

  it("keeps a subagent's or fork's turn no more private than the turn that started it", () => {
    const dashboard = place({ channel: "webchat", ...guardianDm });
    expect(turnAudience(dashboard, { parent: "shared" })).toBe("shared");
    expect(turnAudience(dashboard, { parent: "private" })).toBe("private");
    // A private parent does not make a shared place private.
    expect(turnAudience(place({ threadType: "group" }), { parent: "private" })).toBe("shared");
  });
});

describe("narrowerAudience", () => {
  it("is shared when either side is", () => {
    expect(narrowerAudience("private", undefined)).toBe("private");
    expect(narrowerAudience("private", "private")).toBe("private");
    expect(narrowerAudience("private", "shared")).toBe("shared");
    expect(narrowerAudience("shared", "private")).toBe("shared");
  });
});
