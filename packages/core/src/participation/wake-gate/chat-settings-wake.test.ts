import { describe, expect, it } from "@rstest/core";
import type { BondLevel } from "@rome-os/app-runtime";
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
  sender: BondLevel | "stranger";
  policy?: PolicyRule["action"];
  enabled?: boolean;
  replyRule?: "mention" | "all";
  addressing?: WakeMessage["addressing"];
  fromBot?: boolean;
  mentionsOthers?: boolean;
  openToMembers?: boolean;
  botMessages?: ChatWakeSettings["botMessages"];
  whenOthersMentioned?: ChatWakeSettings["whenOthersMentioned"];
  trusted?: readonly string[];
  replyTo?: readonly string[];
}): WakeDecision {
  const settings: ChatWakeSettings = {
    enabled: row.enabled ?? true,
    replyRule: row.replyRule ?? "mention",
    botMessages: row.botMessages ?? "ignore",
    whenOthersMentioned: row.whenOthersMentioned ?? "ignore",
    trustedLevels: row.trusted ?? ["guardian"],
    replyToLevels: row.replyTo ?? ["guardian"],
    policies: row.policy ? [globalPolicy(row.policy)] : [],
    connectionKindOf: (channel) => channel,
  };
  const person =
    row.sender === "stranger" ? null : { id: `person-${row.sender}`, bondLevel: row.sender };
  const facts = {
    ...(row.addressing ? { addressing: row.addressing } : {}),
    ...(row.fromBot ? { fromBot: true } : {}),
    ...(row.mentionsOthers ? { mentionsOthers: true } : {}),
    ...(row.openToMembers ? { openToMembers: true } : {}),
  };
  return chatSettingsWake(settings)({ ...message, ...facts }, { person });
}

describe("chatSettingsWake", () => {
  // The rows Inbox pinned before the gate moved here (rome-os/rome#2465), and
  // a chat switched off. A row with no policy reads the engine's default.
  it.each([
    // The guardian is trusted by default, so only a block keeps the agent asleep.
    { sender: "guardian", policy: "allow", wake: "wake" },
    { sender: "guardian", policy: "sentinel_review", wake: "wake" },
    { sender: "guardian", policy: "require_approval", wake: "wake" },
    { sender: "guardian", policy: "block", wake: "block" },
    { sender: "guardian", wake: "wake" },

    // By default the agent replies to the guardian alone, so anyone else stays quiet.
    { sender: "stranger", policy: "sentinel_review", wake: "quiet" },
    { sender: "stranger", policy: "allow", wake: "quiet" },
    { sender: "inner-circle", policy: "allow", wake: "quiet" },
    { sender: "acquaintance", policy: "sentinel_review", wake: "quiet" },

    // A block wins over every setting.
    { sender: "stranger", policy: "block", wake: "block" },
    {
      sender: "inner-circle",
      policy: "block",
      trusted: ["guardian", "inner-circle"],
      replyTo: ["guardian", "inner-circle"],
      wake: "block",
    },

    // A sender the agent may reply to: trusted wakes, untrusted goes to review
    // unless the policy allows it.
    {
      sender: "inner-circle",
      policy: "sentinel_review",
      replyTo: ["guardian", "inner-circle"],
      wake: "review",
    },
    {
      sender: "inner-circle",
      policy: "require_approval",
      replyTo: ["guardian", "inner-circle"],
      wake: "review",
    },
    {
      sender: "inner-circle",
      policy: "allow",
      replyTo: ["guardian", "inner-circle"],
      wake: "wake",
    },
    {
      sender: "inner-circle",
      policy: "sentinel_review",
      trusted: ["guardian", "inner-circle"],
      replyTo: ["guardian", "inner-circle"],
      wake: "wake",
    },
    { sender: "stranger", policy: "sentinel_review", replyTo: ["other"], wake: "review" },
    { sender: "stranger", replyTo: ["other"], wake: "review" },
    { sender: "other", policy: "allow", replyTo: ["other"], wake: "wake" },

    // The reply rule wins over trust.
    {
      sender: "inner-circle",
      policy: "allow",
      trusted: ["guardian", "inner-circle"],
      wake: "quiet",
    },
    { sender: "guardian", policy: "allow", replyTo: ["inner-circle"], wake: "quiet" },

    // A chat switched off wakes nobody.
    { sender: "guardian", enabled: false, wake: "quiet" },
    { sender: "guardian", policy: "allow", enabled: false, wake: "quiet" },

    // A chat that wakes only on a mention stays quiet on a message addressed
    // to nobody, even the guardian's. Every other addressing wakes as before.
    { sender: "guardian", addressing: "ambient", wake: "quiet" },
    { sender: "guardian", policy: "allow", addressing: "ambient", wake: "quiet" },
    { sender: "guardian", addressing: "mention", wake: "wake" },
    { sender: "guardian", addressing: "reply", wake: "wake" },
    { sender: "guardian", addressing: "bot_thread", wake: "wake" },
    { sender: "guardian", addressing: "direct", wake: "wake" },
    { sender: "guardian", replyRule: "all", addressing: "ambient", wake: "wake" },
    { sender: "guardian", replyRule: "all", addressing: "ambient", enabled: false, wake: "quiet" },

    // Another bot's message wakes the agent only as far as the chat takes
    // bots, so two bots cannot answer each other forever by default.
    { sender: "guardian", fromBot: true, addressing: "mention", wake: "quiet" },
    {
      sender: "guardian",
      fromBot: true,
      botMessages: "mentions",
      addressing: "reply",
      wake: "quiet",
    },
    {
      sender: "guardian",
      fromBot: true,
      botMessages: "mentions",
      addressing: "mention",
      wake: "wake",
    },
    { sender: "guardian", fromBot: true, botMessages: "all", addressing: "reply", wake: "wake" },

    // A message that mentions only others stays quiet where the chat ignores those.
    { sender: "guardian", mentionsOthers: true, replyRule: "all", wake: "quiet" },
    {
      sender: "guardian",
      mentionsOthers: true,
      replyRule: "all",
      whenOthersMentioned: "respond",
      wake: "wake",
    },
  ] as const)("$sender, policy $policy, enabled $enabled, reply rule $replyRule, $addressing, bot $fromBot/$botMessages, others $mentionsOthers/$whenOthersMentioned, trusted $trusted, reply to $replyTo → $wake", ({
    wake,
    ...row
  }) => {
    expect(decide(row)).toBe(wake);
  });

  it("asks the policies about the linked person, or no one for a stranger", () => {
    const blockAlice: Policy = {
      id: "p1",
      scope: { type: "sender_specific", personId: "person-inner-circle" },
      rules: [{ action: "block" }],
      priority: 0,
    };
    const blockDevChat: Policy = {
      id: "p2",
      scope: { type: "thread", threadName: "Dev Chat", threadType: "group" },
      rules: [{ action: "block" }],
      priority: 0,
    };
    const gate = (policies: Policy[]) =>
      chatSettingsWake({
        enabled: true,
        replyRule: "mention",
        botMessages: "ignore",
        whenOthersMentioned: "ignore",
        trustedLevels: ["guardian"],
        replyToLevels: ["guardian", "inner-circle", "other"],
        policies,
        connectionKindOf: (channel) => channel,
      });

    expect(
      gate([blockAlice])(message, {
        person: { id: "person-inner-circle", bondLevel: "inner-circle" },
      }),
    ).toBe("block");
    expect(gate([blockAlice])(message, { person: null })).toBe("review");
    expect(gate([blockDevChat])(message, { person: null })).toBe("block");
    expect(gate([blockDevChat])({ ...message, place: "direct" }, { person: null })).toBe("review");
  });

  // A connection that opened its account to its workspace's members marks a
  // member's message. Below the reply-to levels, the mark is all that lets
  // them in, so the sentinel always triages them first.
  it.each([
    {
      name: "a marked stranger goes to member review",
      row: { sender: "stranger" },
      wake: "member_review",
    },
    {
      name: "the same stranger unmarked stays quiet",
      row: { sender: "stranger", openToMembers: false },
      wake: "quiet",
    },
    {
      name: "a trusted bond level does not skip member review",
      row: { sender: "other", trusted: ["guardian", "other"] },
      wake: "member_review",
    },
    {
      name: "a policy allow does not skip member review",
      row: { sender: "acquaintance", policy: "allow" },
      wake: "member_review",
    },
    {
      name: "a policy block still blocks",
      row: { sender: "stranger", policy: "block" },
      wake: "block",
    },
    {
      name: "the chat's own rules still keep them quiet",
      row: { sender: "stranger", addressing: "ambient", replyRule: "mention" },
      wake: "quiet",
    },
    {
      name: "a sender the instance replies to is decided as without the mark",
      row: { sender: "acquaintance", replyTo: ["guardian", "acquaintance"], policy: "allow" },
      wake: "wake",
    },
  ] as const)("$name", ({ row, wake }) => {
    expect(decide({ addressing: "direct", openToMembers: true, ...row })).toBe(wake);
  });

  it("answers the same message from the same sender the same way every time", () => {
    const gate = chatSettingsWake({
      enabled: true,
      replyRule: "mention",
      botMessages: "ignore",
      whenOthersMentioned: "ignore",
      trustedLevels: ["guardian"],
      replyToLevels: ["guardian", "other"],
      policies: [],
      connectionKindOf: (channel) => channel,
    });
    const answers = [1, 2, 3].map(() => gate(message, { person: null }));
    expect(answers).toEqual(["review", "review", "review"]);
  });
});
