import { describe, expect, it } from "@rstest/core";
import type { Policy, PolicyRule } from "../../types.js";
import type { ChatWakeSettings, WakeDecision, WakeMessage } from "./index.js";
import { chatSettingsWake } from "./index.js";

const message: WakeMessage = {
  connectionId: "connection:telegram",
  chatId: "chat-1",
  channel: "telegram",
  place: "group",
  threadName: "Dev Chat",
};

/** A global policy answering `action` for every message. */
function globalPolicy(action: PolicyRule["action"]): Policy {
  return { id: "p1", scope: { type: "global" }, rules: [{ action }], priority: 0 } as Policy;
}

function decide(row: {
  policy?: PolicyRule["action"];
  enabled?: boolean;
  replyRule?: "mention" | "all";
  addressing?: WakeMessage["addressing"];
  fromBot?: boolean;
  mentionsOthers?: boolean;
  botMessages?: ChatWakeSettings["botMessages"];
  whenOthersMentioned?: ChatWakeSettings["whenOthersMentioned"];
}): WakeDecision {
  const settings: ChatWakeSettings = {
    enabled: row.enabled ?? true,
    replyRule: row.replyRule ?? "mention",
    botMessages: row.botMessages ?? "ignore",
    whenOthersMentioned: row.whenOthersMentioned ?? "ignore",
    policies: row.policy ? [globalPolicy(row.policy)] : [],
    connectionKindOf: (channel) => channel,
  };
  const facts = {
    ...(row.addressing ? { addressing: row.addressing } : {}),
    ...(row.fromBot ? { fromBot: true } : {}),
    ...(row.mentionsOthers ? { mentionsOthers: true } : {}),
  };
  return chatSettingsWake(settings)({ ...message, ...facts }, { person: null });
}

describe("chatSettingsWake", () => {
  it.each([
    // Its sender was let in, so only a block keeps the agent asleep.
    { wake: "wake" },
    { policy: "allow", wake: "wake" },
    { policy: "sentinel_review", wake: "wake" },
    { policy: "require_approval", wake: "wake" },
    { policy: "block", wake: "block" },

    // A chat switched off wakes nobody.
    { enabled: false, wake: "quiet" },
    { policy: "allow", enabled: false, wake: "quiet" },

    // A chat that wakes only on a mention stays quiet on a message addressed
    // to nobody, whoever says it. Every other addressing wakes as before.
    { addressing: "ambient", wake: "quiet" },
    { policy: "allow", addressing: "ambient", wake: "quiet" },
    { addressing: "mention", wake: "wake" },
    { addressing: "reply", wake: "wake" },
    { addressing: "bot_thread", wake: "wake" },
    { addressing: "direct", wake: "wake" },
    { replyRule: "all", addressing: "ambient", wake: "wake" },
    { replyRule: "all", addressing: "ambient", enabled: false, wake: "quiet" },

    // Another bot's message wakes the agent only as far as the chat takes
    // bots, so two bots cannot answer each other forever by default.
    { fromBot: true, addressing: "mention", wake: "quiet" },
    {
      fromBot: true,
      botMessages: "mentions",
      addressing: "reply",
      wake: "quiet",
    },
    {
      fromBot: true,
      botMessages: "mentions",
      addressing: "mention",
      wake: "wake",
    },
    { fromBot: true, botMessages: "all", addressing: "reply", wake: "wake" },

    // A message that mentions only others stays quiet where the chat ignores those.
    { mentionsOthers: true, replyRule: "all", wake: "quiet" },
    {
      mentionsOthers: true,
      replyRule: "all",
      whenOthersMentioned: "respond",
      wake: "wake",
    },
  ] as const)("policy $policy, enabled $enabled, reply rule $replyRule, $addressing, bot $fromBot/$botMessages, others $mentionsOthers/$whenOthersMentioned → $wake", ({
    wake,
    ...row
  }) => {
    expect(decide(row)).toBe(wake);
  });

  it("asks the policies about the linked person, or no one, and never by bond level", () => {
    const blockAlice: Policy = {
      id: "p1",
      scope: { type: "sender_specific", personId: "person-alice" },
      rules: [{ action: "block" }],
      priority: 0,
    };
    const blockDevChat: Policy = {
      id: "p2",
      scope: { type: "thread", threadName: "Dev Chat", threadType: "group" },
      rules: [{ action: "block" }],
      priority: 0,
    };
    const blockStrangers: Policy = {
      id: "p3",
      scope: { type: "sender", bondLevel: "other" },
      rules: [{ action: "block" }],
      priority: 0,
    };
    const gate = (policies: Policy[]) =>
      chatSettingsWake({
        enabled: true,
        replyRule: "mention",
        botMessages: "ignore",
        whenOthersMentioned: "ignore",
        policies,
        connectionKindOf: (channel) => channel,
      });

    expect(gate([blockAlice])(message, { person: { id: "person-alice" } })).toBe("block");
    expect(gate([blockAlice])(message, { person: null })).toBe("wake");
    expect(gate([blockStrangers])(message, { person: null })).toBe("wake");
    expect(gate([blockDevChat])(message, { person: null })).toBe("block");
    expect(gate([blockDevChat])({ ...message, place: "direct" }, { person: null })).toBe("wake");
  });

  it("answers the same message from the same sender the same way every time", () => {
    const gate = chatSettingsWake({
      enabled: true,
      replyRule: "mention",
      botMessages: "ignore",
      whenOthersMentioned: "ignore",
      policies: [],
      connectionKindOf: (channel) => channel,
    });
    const answers = [1, 2, 3].map(() => gate(message, { person: null }));
    expect(answers).toEqual(["wake", "wake", "wake"]);
  });
});
