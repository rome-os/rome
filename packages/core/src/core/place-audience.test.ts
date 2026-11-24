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
  it("reads a chat private to the guardian as private, with visitors or without", async () => {
    expect(await dashboardChatAudience(concierge(null), true)).toBe("private");
    expect(await dashboardChatAudience({ ...common, triggerKind: "concierge" }, true)).toBe(
      "private",
    );
  });

  it("reads a dashboard admin's Concierge chat as admin while they are on the team", async () => {
    const team = new Set(["visitor:acct-1"]);
    const onTeam = async (owner: string) => team.has(owner);
    expect(await dashboardChatAudience(concierge("visitor:acct-1"), true, onTeam)).toBe("admin");
    expect(
      await dashboardChatAudience(
        { ...common, ownerKey: "visitor:acct-1", triggerKind: "concierge" },
        true,
        onTeam,
      ),
    ).toBe("admin");

    team.clear();
    expect(await dashboardChatAudience(concierge("visitor:acct-1"), true, onTeam)).toBe("shared");
  });

  it("reads a visitor's Concierge chat as shared when they are not on the team", async () => {
    expect(await dashboardChatAudience(concierge("visitor:acct-1"), false)).toBe("shared");
  });

  it("reads a common chat as private only while nobody but the guardian may open the dashboard", async () => {
    expect(await dashboardChatAudience(common, false)).toBe("private");
    expect(await dashboardChatAudience(common, true)).toBe("shared");
    expect(
      await dashboardChatAudience(
        { ...common, ownerKey: "visitor:acct-1" },
        false,
        async () => true,
      ),
    ).toBe("shared");
  });

  it("reads a chat Rome cannot find as shared", async () => {
    expect(await dashboardChatAudience(null, false)).toBe("shared");
  });
});

describe("placeAudience", () => {
  const guardianDm = { threadType: "private" as const, senderBondLevel: "guardian" };

  it("reads a second connection of a kind by its connection kind", async () => {
    const read = placeAudience({
      connectionKindOf: (channel) => channel.replace(/-\d+$/, ""),
      visitorsAllowed: () => false,
    });
    expect(await read({ channel: "telegram-2", threadId: "1", ...guardianDm })).toBe("private");
    expect(await read({ channel: "email-2", threadId: "1", ...guardianDm })).toBe("shared");
  });

  it("reads a direct message as shared while visitors may read its record on the dashboard", async () => {
    const dm = { channel: "telegram", threadId: "1", ...guardianDm };
    expect(await placeAudience({ visitorsAllowed: () => true })(dm)).toBe("shared");
    expect(await placeAudience({})(dm)).toBe("shared");
    expect(await placeAudience({ visitorsAllowed: () => false })(dm)).toBe("private");
  });

  it("reads the sender's bond from People, not from the thread context", async () => {
    // The inbox hook's chat details carry no bond level.
    const fromHook = {
      channel: "slack_app",
      threadId: "D1",
      threadType: "private" as const,
      channelUserId: "U1",
    };
    const read = (bond: string | undefined) =>
      placeAudience({ visitorsAllowed: () => false, senderBondLevel: async () => bond })(fromHook);
    expect(await read("guardian")).toBe("private");
    expect(await read("inner-circle")).toBe("shared");
    expect(await read(undefined)).toBe("shared");
    const claimed = { ...fromHook, senderBondLevel: "guardian" };
    expect(
      await placeAudience({ visitorsAllowed: () => false, senderBondLevel: async () => undefined })(
        claimed,
      ),
    ).toBe("shared");
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
