// What apps receive, and whether it wakes the agent, before and after
// addressing moved out of the connections. The old Discord derivation and
// the old gate checks are copied here as they were, and every combination of
// platform facts and chat settings is run through both. The only difference
// allowed is the agreed one: a message that addresses Rome's account by a
// reply or in Rome's own thread, and also mentions someone else, now
// addresses Rome. Vocabulary: docs/domains/participation.md#addressed.

import type { ChatId, MessageAddressing } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import type { Message } from "../../connections/message.js";
import type {
  ChatWakeSettings,
  WakeDecision,
  WakeMessage,
} from "../../participation/wake-gate/index.js";
import { chatSettingsWake } from "../../participation/wake-gate/index.js";
import { channelMessageOf } from "./channel-message.js";

const ME = "rome-1";
const OTHER_ROME = "rome-2";

interface Facts {
  kind: "direct" | "group";
  mentions: readonly string[] | undefined;
  repliesTo: string | null | undefined;
  threadStartedBy: string | null | undefined;
  isBot: boolean;
}

function* allFacts(): Generator<Facts> {
  for (const kind of ["direct", "group"] as const)
    for (const mentions of [undefined, [], [ME], ["ann"], [ME, "ann"], [OTHER_ROME]])
      for (const repliesTo of [undefined, null, ME, "ann"])
        for (const threadStartedBy of [undefined, null, ME, "ann"])
          for (const isBot of [false, true])
            yield { kind, mentions, repliesTo, threadStartedBy, isBot };
}

/** `facts` as a connection reports them, received by `me`. `null` is a reply
 *  or thread whose author the platform does not say. */
function messageOf(facts: Facts, me = ME): Message {
  return {
    id: "m-1",
    where: {
      chatId: "c-1" as ChatId,
      kind: facts.kind,
      ...(facts.threadStartedBy !== undefined
        ? {
            thread: {
              parentChatId: "c-0" as ChatId,
              ...(facts.threadStartedBy !== null ? { startedBy: facts.threadStartedBy } : {}),
            },
          }
        : {}),
    },
    sender: { accountId: "ann", ...(facts.isBot ? { isBot: true } : {}) },
    content: { text: "hi", attachments: [] },
    receivedBy: me,
    ...(facts.mentions !== undefined ? { mentions: facts.mentions } : {}),
    ...(facts.repliesTo !== undefined
      ? {
          replyTo: {
            messageId: "m-0",
            ...(facts.repliesTo !== null ? { senderAccountId: facts.repliesTo } : {}),
          },
        }
      : {}),
    saidAt: new Date(0),
  };
}

/** What the Discord connection worked out from the same facts before. */
function oldDiscord(facts: Facts): Pick<WakeMessage, "addressing" | "fromBot" | "mentionsOthers"> {
  const fromBot = facts.isBot ? { fromBot: true } : {};
  if (facts.kind === "direct") return { addressing: "direct", ...fromBot };
  const mentions = facts.mentions ?? [];
  const addressing: MessageAddressing = mentions.includes(ME)
    ? "mention"
    : facts.repliesTo === ME
      ? "reply"
      : facts.threadStartedBy === ME
        ? "bot_thread"
        : "ambient";
  const mentionsOthers = mentions.length > 0 && !mentions.includes(ME);
  return { addressing, ...fromBot, ...(mentionsOthers ? { mentionsOthers: true } : {}) };
}

/** The gate's checks on addressing before, as they were. */
function oldAddressingQuiet(message: WakeMessage, settings: ChatWakeSettings): boolean {
  if (message.fromBot) {
    if (settings.botMessages === "ignore") return true;
    if (settings.botMessages === "mentions" && message.addressing !== "mention") return true;
  }
  if (message.mentionsOthers && settings.whenOthersMentioned === "ignore") return true;
  if (settings.replyRule === "mention" && message.addressing === "ambient") return true;
  return false;
}

function* allSettings(): Generator<ChatWakeSettings> {
  for (const replyRule of ["mention", "all"] as const)
    for (const botMessages of ["ignore", "mentions", "all"] as const)
      for (const whenOthersMentioned of ["ignore", "respond"] as const)
        yield {
          enabled: true,
          replyRule,
          botMessages,
          whenOthersMentioned,
          trustedLevels: ["guardian"],
          replyToLevels: ["guardian"],
          policies: [],
          connectionKindOf: (channel) => channel,
        };
}

function wakeMessageOf(
  fields: Pick<WakeMessage, "addressing" | "fromBot" | "mentionsOthers">,
  place: Facts["kind"],
): WakeMessage {
  return {
    connectionId: "connection:discord",
    chatId: "c-1",
    channel: "discord",
    place,
    ...fields,
  };
}

const GUARDIAN = { person: { id: "p-1", bondLevel: "guardian" as const } };

/** The agreed change: Rome's account is addressed by a reply or its own thread, not a mention, and someone else is mentioned. */
function isAgreedChange(facts: Facts): boolean {
  const mentions = facts.mentions ?? [];
  return (
    facts.kind === "group" &&
    !mentions.includes(ME) &&
    mentions.length > 0 &&
    (facts.repliesTo === ME || facts.threadStartedBy === ME)
  );
}

describe("channelMessageOf", () => {
  it("gives apps the addressing the Discord connection gave, for every combination of facts", () => {
    const differ: string[] = [];
    for (const facts of allFacts()) {
      if (facts.mentions === undefined) continue; // Discord always says whom a message mentions.
      const now = channelMessageOf(messageOf(facts), "discord");
      const before = oldDiscord(facts);
      const same =
        now.addressing === before.addressing &&
        now.fromBot === before.fromBot &&
        now.mentionsOthers === before.mentionsOthers;
      if (!same && !isAgreedChange(facts)) differ.push(JSON.stringify(facts));
    }
    expect(differ).toEqual([]);
  });

  it("leaves addressing to the app where the connection cannot tell whom a message mentions", () => {
    for (const facts of allFacts()) {
      if (facts.mentions !== undefined) continue;
      const now = channelMessageOf(messageOf(facts), "email");
      expect(now.addressing).toBeUndefined();
      expect(now.mentionsOthers).toBeUndefined();
    }
  });

  it("wakes the agent as before for every combination of facts and settings, apart from the agreed change", () => {
    const differ: string[] = [];
    const changed: string[] = [];
    for (const facts of allFacts()) {
      if (facts.mentions === undefined) continue;
      for (const settings of allSettings()) {
        const now = chatSettingsWake(settings)(
          wakeMessageOf(channelMessageOf(messageOf(facts), "discord"), facts.kind),
          GUARDIAN,
        );
        const beforeMessage = wakeMessageOf(oldDiscord(facts), facts.kind);
        const before: WakeDecision = oldAddressingQuiet(beforeMessage, settings)
          ? "quiet"
          : chatSettingsWake(settings)(beforeMessage, GUARDIAN);
        if (now === before) continue;
        const row = `${JSON.stringify(facts)} ${settings.replyRule}/${settings.botMessages}/${settings.whenOthersMentioned}: ${before} → ${now}`;
        (isAgreedChange(facts) ? changed : differ).push(row);
      }
    }
    expect(differ).toEqual([]);
    // The change is real, and only where the chat ignores mentions of others.
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((row) => row.includes("/ignore: quiet → wake"))).toBe(true);
  });

  it("wakes the agent as before on Telegram and Feishu, which never reported mentions of others", () => {
    // Neither kind offers the bot or mentions-of-others rules, so a chat on it
    // wakes on any bot and on mentions of others, and the new mentionsOthers
    // changes nothing (participation/wake-gate/load.ts).
    const differ: string[] = [];
    for (const facts of allFacts()) {
      if (facts.mentions === undefined) continue;
      for (const replyRule of ["mention", "all"] as const) {
        const settings: ChatWakeSettings = {
          ...(allSettings().next().value as ChatWakeSettings),
          replyRule,
          botMessages: "all",
          whenOthersMentioned: "respond",
        };
        const { mentionsOthers: _never, ...before } = oldDiscord(facts);
        const now = chatSettingsWake(settings)(
          wakeMessageOf(channelMessageOf(messageOf(facts), "telegram"), facts.kind),
          GUARDIAN,
        );
        const was = chatSettingsWake(settings)(wakeMessageOf(before, facts.kind), GUARDIAN);
        if (now !== was) differ.push(`${JSON.stringify(facts)} ${replyRule}: ${was} → ${now}`);
      }
    }
    expect(differ).toEqual([]);
  });

  it("reads one message in a group differently for each of Rome's accounts that heard it", () => {
    const settings = allSettings().next().value as ChatWakeSettings; // mention / ignore / ignore
    const facts: Facts = {
      kind: "group",
      mentions: [OTHER_ROME],
      repliesTo: undefined,
      threadStartedBy: undefined,
      isBot: false,
    };
    const forMe = channelMessageOf(messageOf(facts, ME), "discord");
    const forOther = channelMessageOf(messageOf(facts, OTHER_ROME), "discord");
    expect([forMe.addressing, forMe.mentionsOthers]).toEqual(["ambient", true]);
    expect([forOther.addressing, forOther.mentionsOthers]).toEqual(["mention", undefined]);
    expect(chatSettingsWake(settings)(wakeMessageOf(forMe, "group"), GUARDIAN)).toBe("quiet");
    expect(chatSettingsWake(settings)(wakeMessageOf(forOther, "group"), GUARDIAN)).toBe("wake");
  });
});
