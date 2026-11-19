import { describe, expect, it } from "@rstest/core";
import {
  agentOnConnect,
  CONCIERGE_CHAT_ACTIONS,
  CONNECTION_PROMPT,
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
      systemPromptPrefix: CONNECTION_PROMPT,
      handoffOnRenewal: false,
      withoutActions: CONCIERGE_CHAT_ACTIONS,
      withoutDefer: true,
    });
    expect(CONCIERGE_CHAT_ACTIONS).toContain("core:concierge_follow");
    // Renaming checks a dashboard chat's owner, so a bot turn is refused even for the guardian.
    expect(CONCIERGE_CHAT_ACTIONS).toContain("core:set_agent_name");
    expect(conciergePlaceSetup("core:concierge", { channel: "webchat" })).toBeNull();
    expect(conciergePlaceSetup("core:concierge", undefined)).toBeNull();
    expect(conciergePlaceSetup("core:main", { channel: "telegram" })).toBeNull();
  });

  it("answers in its own words with nothing to close the turn, and calls nothing the dashboard has", () => {
    expect(CONNECTION_PROMPT).toContain('never add a closing word or line such as "done"');
    expect(CONNECTION_PROMPT).toContain("Never call a tool or action you were not given");
    expect(CONNECTION_PROMPT).toContain("Never put a code, password, token or other secret");
    expect(CONNECTION_PROMPT).toContain(
      "never repeat it in a chat that someone other than the guardian can read",
    );
    // The dashboard's ways of speaking are never named, so nothing invites a call.
    for (const name of ["`say`", "`react`", "`defer`", "chat_start", "show_card"]) {
      expect(CONNECTION_PROMPT).not.toContain(name);
    }
  });

  it("reads the chat's earlier messages from the connection, never sending anyone to the dashboard for them", () => {
    expect(CONNECTION_PROMPT).toContain("`system:fetch_channel_history`");
    expect(CONNECTION_PROMPT).toContain("Some connections cannot read their history");
    expect(CONNECTION_PROMPT).toContain("Never send anyone to the dashboard for them.");
  });
});
