import { describe, expect, it } from "@rstest/core";
import type { Agent } from "../agent/index.js";
import { bypassesInbox } from "./inbox-bypass.js";

function agent(
  ownerId: string,
  bypass: boolean | undefined,
  ownerType: Agent["ownerType"] = "app",
): Agent {
  return {
    name: `${ownerId}:agent` as Agent["name"],
    localName: "agent",
    ownerType,
    ownerId,
    definition: {
      description: "",
      reasoningEffort: "low",
      systemPromptPrefix: "",
      tools: [],
      permissionMode: "default",
      ...(bypass === undefined ? {} : { unsafeTestOnlyBypassInbox: bypass }),
    },
  };
}

describe("bypassesInbox", () => {
  it("lets the chief of staff's agent keep Inbox off its accounts", () => {
    expect(bypassesInbox(agent("chief-of-staff", true))).toBe(true);
  });

  it("refuses every other app, core, and an agent that does not ask", () => {
    expect(bypassesInbox(agent("sales", true))).toBe(false);
    expect(bypassesInbox(agent("chief-of-staff", true, "core"))).toBe(false);
    expect(bypassesInbox(agent("chief-of-staff", false))).toBe(false);
    expect(bypassesInbox(agent("chief-of-staff", undefined))).toBe(false);
    expect(bypassesInbox(undefined)).toBe(false);
  });
});
