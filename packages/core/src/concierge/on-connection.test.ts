import { describe, expect, it } from "@rstest/core";
import {
  agentOfKind,
  CONCIERGE_CHAT_ACTIONS,
  CONNECTION_PROMPT,
  CONNECTION_TOOLS,
  conciergePlaceSetup,
  WORKSPACE_PROMPT,
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
    // Renaming checks a dashboard chat's owner, so a bot turn is refused even for the guardian.
    expect(CONCIERGE_CHAT_ACTIONS).toContain("core:set_agent_name");
    // A shown file links to the dashboard's assets, which a bot chat cannot open.
    expect(CONCIERGE_CHAT_ACTIONS).toContain("core:show_file");
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
    expect(CONNECTION_PROMPT).toContain(
      "never repeat it in a chat that someone other than the guardian can read",
    );
    // The dashboard's ways of speaking are never named, so nothing invites a call.
    for (const name of ["`defer`", "show_card", "card_forward", "ask_question"]) {
      expect(CONNECTION_PROMPT).not.toContain(name);
    }
  });

  it("runs tasks with the tools it keeps, and approves nothing itself", () => {
    for (const name of CONNECTION_TOOLS) expect(CONNECTION_PROMPT).toContain(`\`${name}\``);
    expect(CONNECTION_PROMPT).toContain("Only the guardian may ask for one");
    expect(CONNECTION_PROMPT).toContain("Never approve anything yourself.");
  });

  it("tells a session that serves its workspace where each message was said, and how to send elsewhere", () => {
    const serves = (thread: { channel: string; connectionId?: string }) =>
      thread.connectionId === "slack";
    const setup = conciergePlaceSetup(
      "core:concierge",
      { channel: "slack_app", connectionId: "slack" },
      serves,
    );
    expect(setup?.systemPromptPrefix).toContain(WORKSPACE_PROMPT);
    // Anyone in the workspace may ask for a task there.
    expect(setup?.systemPromptPrefix).toContain("Anyone in this workspace may ask for one.");
    expect(setup?.systemPromptPrefix).not.toContain("Only the guardian may ask for one");
    expect(setup?.systemPromptPrefix).not.toContain("Only the guardian's messages take one");
    expect(WORKSPACE_PROMPT).toContain("`<place>`");
    expect(WORKSPACE_PROMPT).toContain("`send`");
    // Every other account, and the Concierge without the rule, keep theirs.
    expect(
      conciergePlaceSetup("core:concierge", { channel: "discord_app", connectionId: "d" }, serves)
        ?.systemPromptPrefix,
    ).toBe(CONNECTION_PROMPT);
    expect(conciergePlaceSetup("core:concierge", { channel: "webchat" }, () => true)).toBeNull();
  });

  it("reads the chat's earlier messages from the connection, never sending anyone to the dashboard for them", () => {
    expect(CONNECTION_PROMPT).toContain("`system:fetch_channel_history`");
    expect(CONNECTION_PROMPT).toContain("Some connections cannot read their history");
    expect(CONNECTION_PROMPT).toContain("Never send anyone to the dashboard for them.");
  });
});
