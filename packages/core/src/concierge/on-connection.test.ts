import { describe, expect, it } from "@rstest/core";
import {
  agentOfKind,
  CONCIERGE_CHAT_ACTIONS,
  CONNECTION_PROMPT,
  CONNECTION_TOOLS,
  conciergePlaceSetup,
} from "./on-connection.js";

describe("the Concierge on a connection", () => {
  it("answers an own account as the Concierge only when its kind asks for it, and main otherwise", () => {
    expect(agentOfKind("own_account", true)).toBe("core:concierge");
    expect(agentOfKind("own_account", false)).toBe("core:main");
    expect(agentOfKind("delegate", true)).toBe("core:main");
    expect(agentOfKind("delegate", false)).toBe("core:main");
    expect(agentOfKind(null, true)).toBeNull();
  });

  it("keeps its text private and withholds every action that needs a Concierge chat, only on a connection", () => {
    // No finalText: the Concierge's own, private, holds here too.
    expect(conciergePlaceSetup("core:concierge", { channel: "telegram" })).toEqual({
      systemPromptPrefix: CONNECTION_PROMPT,
      handoffOnRenewal: false,
      withoutActions: CONCIERGE_CHAT_ACTIONS,
      withoutDefer: true,
    });
    expect(CONCIERGE_CHAT_ACTIONS).toContain("core:concierge_follow");
    expect(CONCIERGE_CHAT_ACTIONS).not.toContain("core:set_agent_name");
    expect(CONNECTION_PROMPT).toContain("To change your own name, call `core:set_agent_name`.");
    // A shown file links to the dashboard's assets, which a bot chat cannot open.
    expect(CONCIERGE_CHAT_ACTIONS).toContain("core:show_file");
    // Listing routines shows every routine and its arguments, for the guardian alone.
    expect(CONCIERGE_CHAT_ACTIONS).toContain("system:search_routine");
    expect(CONCIERGE_CHAT_ACTIONS).toContain("system:read_routines");
    expect(conciergePlaceSetup("core:concierge", { channel: "webchat" })).toBeNull();
    expect(conciergePlaceSetup("core:concierge", undefined)).toBeNull();
    expect(conciergePlaceSetup("core:main", { channel: "telegram" })).toBeNull();
  });

  it("speaks only through say, ends each turn with done, and calls nothing the dashboard has", () => {
    expect(CONNECTION_PROMPT).toContain("`say` is the only way anyone here hears you");
    expect(CONNECTION_PROMPT).toContain("Text you write outside `say` is private");
    expect(CONNECTION_PROMPT).toContain("End every turn by writing only `done`");
    expect(CONNECTION_PROMPT).toContain("Never call a tool or action you were not given");
    expect(CONNECTION_PROMPT).toContain("`say` refuses `private`");
    expect(CONNECTION_PROMPT).toContain("Never say a code, password, token or other secret");
    // The dashboard's ways of speaking are never named, so nothing invites a call.
    for (const name of ["`defer`", "show_card", "card_forward", "ask_question"]) {
      expect(CONNECTION_PROMPT).not.toContain(name);
    }
  });

  it("helps every member who writes as it helps the guardian, keeping secrets and what a member asked to keep out", () => {
    expect(CONNECTION_PROMPT).toContain("Everyone who writes to you here is a member of this Rome");
    expect(CONNECTION_PROMPT).toContain("help each of them as you help the guardian");
    expect(CONNECTION_PROMPT).toContain("When a member asks about personal data or a device");
    expect(CONNECTION_PROMPT).toContain("leave out anything a member asked you to keep out of it");
    expect(CONNECTION_PROMPT).toContain(
      "A line marked `not linked` is from someone who is not a member",
    );
    expect(CONNECTION_PROMPT).toContain("say it waits for approval on the dashboard");
    expect(CONNECTION_PROMPT).toContain(
      "Any member may read any chat of this Rome and its tasks, including another member's Concierge chat",
    );
    // Nothing says whose phone, devices or data they are, so nothing reads as a reason to refuse.
    expect(CONNECTION_PROMPT).not.toMatch(
      /(phone|devices?|data) (that .* )?(is|are) the guardian's/,
    );
    expect(CONNECTION_PROMPT).not.toContain("is the guardian's");
    expect(CONNECTION_PROMPT).not.toContain("are the guardian's");
    // No line refuses a member because others can read the chat, or names it the guardian's.
    for (const text of [
      "Others may read this chat",
      "the guardian's agent",
      "Someone other than the guardian",
    ]) {
      expect(CONNECTION_PROMPT).not.toContain(text);
    }
  });

  it("runs tasks for whoever asks with the tools it keeps, and approves nothing itself", () => {
    for (const name of CONNECTION_TOOLS) expect(CONNECTION_PROMPT).toContain(`\`${name}\``);
    expect(CONNECTION_PROMPT).not.toContain("Only the guardian may ask for one");
    expect(CONNECTION_PROMPT).toContain("Never approve anything yourself.");
  });

  it("reads the chat's earlier messages from the connection, never sending anyone to the dashboard for them", () => {
    expect(CONNECTION_PROMPT).toContain("`system:fetch_channel_history`");
    expect(CONNECTION_PROMPT).toContain("Some connections cannot read their history");
    expect(CONNECTION_PROMPT).toContain("Never send anyone to the dashboard for them.");
  });
});
