import { describe, expect, it } from "@rstest/core";
import type { ThreadContext } from "@rome-os/app-runtime";
import { narrowerAudience, readByActorAlone, turnAudience } from "./turn-audience.js";

const place = (overrides: Partial<ThreadContext>): ThreadContext => ({
  channel: "telegram",
  threadId: "t-1",
  ...overrides,
});

const guardianDm = { threadType: "private" as const, senderBondLevel: "guardian" };

describe("turnAudience", () => {
  it("reads a dashboard chat as its opener read it, and as shared when it read nothing", () => {
    const dashboard = place({ channel: "webchat", ...guardianDm });
    expect(turnAudience(dashboard, { place: "private" })).toBe("private");
    expect(turnAudience(dashboard, { place: "shared" })).toBe("shared");
    expect(turnAudience(dashboard)).toBe("shared");
  });

  it.each([
    "telegram",
    "telegram_user",
    "whatsapp",
    "discord",
    "wechat",
    "linkedin",
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

  it("reads a turn with no chat of its own as the turn that started it", () => {
    expect(turnAudience(undefined, { parent: "private" })).toBe("private");
    expect(turnAudience(undefined, { parent: "shared" })).toBe("shared");
    // An agent summoned by a summoned agent keeps the first turn's audience.
    const first = turnAudience(undefined, { parent: "private" });
    expect(turnAudience(undefined, { parent: first })).toBe("private");
    expect(turnAudience(undefined, { parent: "private", actor: { kind: "visitor" } })).toBe(
      "shared",
    );
  });

  it("reads a turn that acts for a visitor as shared, even in a private chat", () => {
    const dashboard = place({ channel: "webchat", ...guardianDm });
    expect(turnAudience(dashboard, { place: "private", actor: { kind: "visitor" } })).toBe(
      "shared",
    );
    expect(turnAudience(dashboard, { place: "private", actor: { kind: "guardian" } })).toBe(
      "private",
    );
  });

  it("keeps a subagent's or fork's turn no more private than the turn that started it", () => {
    const dashboard = place({ channel: "webchat", ...guardianDm });
    expect(turnAudience(dashboard, { place: "private", parent: "shared" })).toBe("shared");
    expect(turnAudience(dashboard, { place: "private", parent: "private" })).toBe("private");
    // A private parent does not make a shared place private.
    expect(turnAudience(place({ threadType: "group" }), { parent: "private" })).toBe("shared");
  });
});

describe("a dashboard admin's turn", () => {
  const dashboard = place({ channel: "webchat", threadType: "private" });
  const visitor = { kind: "visitor" };

  it("is admin in a chat read as theirs, and shared anywhere else", () => {
    expect(turnAudience(dashboard, { place: "admin", actor: visitor })).toBe("admin");
    expect(turnAudience(dashboard, { place: "shared", actor: visitor })).toBe("shared");
  });

  it("never reads as the guardian's own, even where the guardian's would", () => {
    expect(turnAudience(dashboard, { place: "private", actor: visitor })).toBe("shared");
  });

  it("is admin for no one's turn in their chat, such as a routine's, and shared for the guardian's", () => {
    expect(turnAudience(dashboard, { place: "admin" })).toBe("admin");
    expect(turnAudience(dashboard, { place: "admin", actor: { kind: "guardian" } })).toBe("shared");
  });

  it("keeps a subagent's or fork's turn no more private than the one that started it", () => {
    expect(turnAudience(dashboard, { place: "admin", actor: visitor, parent: "shared" })).toBe(
      "shared",
    );
    expect(turnAudience(undefined, { parent: "admin", actor: visitor })).toBe("admin");
    expect(turnAudience(dashboard, { place: "private", parent: "admin" })).toBe("admin");
  });
});

describe("narrowerAudience", () => {
  it("is shared when either side is, and admin when either is and neither is shared", () => {
    expect(narrowerAudience("private", undefined)).toBe("private");
    expect(narrowerAudience("private", "private")).toBe("private");
    expect(narrowerAudience("private", "shared")).toBe("shared");
    expect(narrowerAudience("shared", "private")).toBe("shared");
    expect(narrowerAudience("admin", "private")).toBe("admin");
    expect(narrowerAudience("private", "admin")).toBe("admin");
    expect(narrowerAudience("admin", "shared")).toBe("shared");
  });
});

describe("readByActorAlone", () => {
  it("is the guardian in a private turn, or a dashboard admin in an admin one", () => {
    expect(readByActorAlone({ kind: "guardian" }, "private")).toBe(true);
    expect(readByActorAlone({ kind: "visitor" }, "admin")).toBe(true);
    expect(readByActorAlone({ kind: "guardian" }, "admin")).toBe(false);
    expect(readByActorAlone({ kind: "visitor" }, "private")).toBe(false);
    expect(readByActorAlone(undefined, "private")).toBe(false);
    expect(readByActorAlone({ kind: "visitor" }, "shared")).toBe(false);
  });
});
