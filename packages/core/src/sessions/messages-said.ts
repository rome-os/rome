// Agents hearing what Chats records from the channels, and the hook's port
// onto it. Vocabulary: docs/domains/participation.md#wake.
//
// A message said to Rome wakes an agent or does not, and until that is
// decided no catch-up reads it. Agents holds it out from the moment Chats
// raises MessageSaid, and lets it go once the hook that heard it says the wake
// is decided. Nothing hears through it until the Chats switch.

import type { InboundEvent, MessagesSaid, SaidInboundEvent } from "@rome-os/app-runtime";
import type { ChatRepository } from "../chats/storage/chat-repository.js";
import type { ChatEvents, MessageSaid } from "../chats/storage/events.js";
import type { InboundRecording } from "../connections/inbound-recording.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { TurnLinks } from "./turn-links.js";

export interface MessagesSaidDeps {
  /** Where a message's chat is found, for its kind. */
  chats: Pick<ChatRepository, "find">;
  /** Opens the session of the account that heard a message, in its chat. */
  sessions: Pick<WebChatRepository, "ensureChannelChat">;
  /** What Chats records from the channels, while anyone listens. */
  recording: Pick<InboundRecording, "listen" | "heard">;
  events: ChatEvents;
  /** Holds a message out of every catch-up until its wake is decided. */
  wakes: Pick<TurnLinks, "wakeUndecided" | "wakeDecided">;
}

/**
 * The hook's port onto recorded messages. Call it before anything else
 * listens to `events`: its listener holds each message out of catch-up, and
 * Chats raises MessageSaid in the same step it records the message, so the
 * first listener acts before anything can read it.
 *
 * Each raise is held once, and let go once every hook that was hearing when
 * it was raised has decided it, or has left.
 */
export function messagesSaid(deps: MessagesSaidDeps): MessagesSaid {
  /** The hooks hearing now. */
  const hearers = new Set<symbol>();
  /** Each raise still held, with the hooks that have yet to decide it. */
  const owed = new Map<MessageSaid, Set<symbol>>();
  /** The raises handed to a hook and not yet decided, by message and
   *  session, as the hook names them back, each with the hooks it was handed
   *  to in turn. */
  const handed = new Map<string, { event: MessageSaid; hearer: symbol }[]>();

  /** Hook `hearer` is done with `event`: once every hook is, its wake is
   *  decided. */
  const settle = (event: MessageSaid, hearer: symbol): void => {
    const waiting = owed.get(event);
    if (!waiting?.delete(hearer) || waiting.size > 0) return;
    owed.delete(event);
    deps.wakes.wakeDecided(event.message.id);
  };

  deps.events.subscribe((event) => {
    // Only while a hook hears messages is anyone there to decide the wake.
    if (event.type !== "MessageSaid" || hearers.size === 0) return;
    owed.set(event, new Set(hearers));
    deps.wakes.wakeUndecided(event.message.id);
  });

  return {
    subscribe(handler) {
      const hearer = Symbol("hearer");
      hearers.add(hearer);
      const unlisten = deps.recording.listen();
      const unsubscribe = deps.events.subscribe(async (event) => {
        if (event.type !== "MessageSaid" || !owed.get(event)?.has(hearer)) return;
        // The hook still reads the platform's event, which the adapter holds
        // while it delivers the message, and Chats never sees.
        const heard = deps.recording.heard(event.via.channel, event.message.id);
        if (!heard) {
          // Handed to nobody, as while a hook is being swapped: nothing will
          // decide its wake, so it stands decided as a message no agent
          // answered.
          settle(event, hearer);
          return;
        }
        let speaker: string;
        try {
          speaker = await speakerOf(deps, event, heard);
        } catch (error) {
          // Never handed over, so nothing else will decide its wake.
          settle(event, hearer);
          throw error;
        }
        const recorded: SaidInboundEvent = {
          ...heard,
          recorded: { chatRecordId: speaker, messageId: String(event.message.id) },
        };
        const key = handedKey(recorded.recorded);
        handed.set(key, [...(handed.get(key) ?? []), { event, hearer }]);
        await handler(recorded);
      });
      let left = false;
      return () => {
        if (left) return;
        left = true;
        hearers.delete(hearer);
        unsubscribe();
        unlisten();
        // What it never decided, nobody will.
        for (const [key, raises] of handed) {
          const kept = raises.filter((raise) => raise.hearer !== hearer);
          if (kept.length > 0) handed.set(key, kept);
          else handed.delete(key);
        }
        for (const event of [...owed.keys()]) settle(event, hearer);
      };
    },
    decided: async (recorded) => {
      const key = handedKey(recorded);
      const [first, ...rest] = handed.get(key) ?? [];
      if (!first) return;
      if (rest.length > 0) handed.set(key, rest);
      else handed.delete(key);
      settle(first.event, first.hearer);
    },
  };
}

/** A raise handed to a hook, as the hook names it back. */
function handedKey(recorded: SaidInboundEvent["recorded"]): string {
  return `${recorded.messageId}\0${recorded.chatRecordId}`;
}

/**
 * The session of the account that heard `event`'s message, in its chat,
 * opened when it holds none, by its id. A chat starts answered by main; its
 * own agent, when it has one, was set through its settings.
 */
async function speakerOf(
  deps: MessagesSaidDeps,
  event: MessageSaid,
  heard: InboundEvent,
): Promise<string> {
  const { place, at } = event.message;
  const kind = deps.chats.find(place.chat.id)?.kind ?? "group";
  const threadName = heard.message.thread?.name;
  const session = await deps.sessions.ensureChannelChat({
    channel: event.via.channel,
    threadId: heard.message.chatId,
    ...(heard.message.parentChatId === undefined
      ? {}
      : { parentThreadId: heard.message.parentChatId }),
    ...(threadName === undefined ? {} : { threadName }),
    threadType: kind === "dm" ? "private" : "group",
    agentName: "main",
    speaker: { chat: place.chat, accountId: event.via.account.id, at },
  });
  return session.id;
}
