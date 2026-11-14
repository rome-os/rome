import { describe, expect, it } from "@rstest/core";
import type { ChatPrivacyRow } from "../webchat/privacy.js";
import { dashboardChatAudience, placeAudience } from "./place-audience.js";

const concierge = (ownerKey: string | null): ChatPrivacyRow => ({
  id: "topic-1",
  agentName: "core:concierge",
  ownerKey,
});
const common: ChatPrivacyRow = { id: "chat-1", agentName: "main", ownerKey: null };

describe("dashboardChatAudience", () => {
  it("reads a chat private to the guardian as private, with visitors or without", () => {
    expect(dashboardChatAudience(concierge(null), true)).toBe("private");
    expect(dashboardChatAudience({ ...common, triggerKind: "concierge" }, true)).toBe("private");
  });

  it("reads a visitor's Concierge chat as shared", () => {
    expect(dashboardChatAudience(concierge("visitor:acct-1"), false)).toBe("shared");
  });

  it("reads a common chat as private only while nobody but the guardian may open the dashboard", () => {
    expect(dashboardChatAudience(common, false)).toBe("private");
    expect(dashboardChatAudience(common, true)).toBe("shared");
    expect(dashboardChatAudience({ ...common, ownerKey: "visitor:acct-1" }, false)).toBe("shared");
  });

  it("reads a chat Rome cannot find as shared", () => {
    expect(dashboardChatAudience(null, false)).toBe("shared");
  });
});

describe("placeAudience", () => {
  const guardianDm = { threadType: "private" as const, senderBondLevel: "guardian" };

  it("reads a second connection of a kind by its connection kind", async () => {
    const read = placeAudience({ connectionKindOf: (channel) => channel.replace(/-\d+$/, "") });
    expect(await read({ channel: "telegram-2", threadId: "1", ...guardianDm })).toBe("private");
    expect(await read({ channel: "email-2", threadId: "1", ...guardianDm })).toBe("shared");
  });

  it("looks a dashboard chat up, and fails closed without the lookup or a place", async () => {
    const read = placeAudience({
      dashboardChat: async (id) => (id === "chat-1" ? common : null),
      visitorsAllowed: () => false,
    });
    expect(await read({ channel: "webchat", threadId: "chat-1" })).toBe("private");
    expect(await read({ channel: "webchat", threadId: "gone" })).toBe("shared");
    expect(await placeAudience({})({ channel: "webchat", threadId: "chat-1" })).toBe("shared");
    expect(await read(undefined)).toBe("shared");
  });
});
