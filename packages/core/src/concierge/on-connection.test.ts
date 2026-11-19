import { describe, expect, it } from "@rstest/core";
import {
  agentOnConnect,
  CONCIERGE_CHAT_ACTIONS,
  CONNECTION_INSTRUCTION,
  chatInstructionsOf,
  conciergeOnConnection,
  conciergePlaceSetup,
} from "./on-connection.js";

describe("the Concierge on a connection", () => {
  it("starts a newly connected own account with the Concierge, and a delegate or a kind that takes no agent with none", () => {
    expect(agentOnConnect("own_account")).toBe("core:concierge");
    expect(agentOnConnect("delegate")).toBeNull();
    expect(agentOnConnect(null)).toBeNull();
  });

  it("delivers its text and withholds every action that needs a Concierge chat, only on a connection", () => {
    expect(conciergePlaceSetup("core:concierge", { channel: "telegram" })).toEqual({
      finalText: "deliver",
      withoutActions: CONCIERGE_CHAT_ACTIONS,
    });
    expect(CONCIERGE_CHAT_ACTIONS).toContain("core:concierge_follow");
    expect(conciergePlaceSetup("core:concierge", { channel: "webchat" })).toBeNull();
    expect(conciergePlaceSetup("core:concierge", undefined)).toBeNull();
    expect(conciergePlaceSetup("core:main", { channel: "telegram" })).toBeNull();
  });

  it("adds its instruction only to the Concierge, and only on a connection", async () => {
    expect(await conciergeOnConnection({ channel: "slack" }, "core:concierge")).toBe(
      CONNECTION_INSTRUCTION,
    );
    expect(await conciergeOnConnection({ channel: "webchat" }, "core:concierge")).toBeNull();
    expect(await conciergeOnConnection({ channel: "slack" }, "core:main")).toBeNull();
    expect(await conciergeOnConnection(undefined, "core:concierge")).toBeNull();
  });

  it("joins every chat instruction that adds one, and answers null when none does", async () => {
    const combined = chatInstructionsOf([
      async () => "first",
      async () => null,
      async (_thread, agent) => `for ${agent}`,
    ]);
    expect(await combined(undefined, "core:concierge")).toBe("first\n\nfor core:concierge");
    expect(await chatInstructionsOf([async () => null])(undefined, "core:main")).toBeNull();
  });
});
