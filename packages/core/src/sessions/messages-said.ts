// Agents hearing what Chats records from the channels, and the hook's port
// onto it. Vocabulary: docs/domains/participation.md#wake.
//
// A message said to Rome wakes an agent or does not, and until that is
// decided no catch-up reads it. Agents holds it out from the moment Chats
// raises MessageSaid, and lets it go once the hook that heard it says the wake
// is decided.

import type { InboundEvent, MessagesSaid, SaidInboundEvent } from "@rome-os/app-runtime";
import type { ChatRepository } from "../chats/chat-repository.js";
import type { ChatEvents, MessageSaid } from "../chats/events.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { InboundRecording } from "../chats/inbound.js";
import type { TurnLinks } from "./turn-links.js";

export interface MessagesSaidDeps {
  /** Where a message's chat is found, for its kind. */
  chats: Pick<ChatRepository, "find">;
  /** Opens the seat of the account that heard a message, in its chat. */
  seats: Pick<WebChatRepository, "ensureChannelChat" | "advanceActivity">;
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
 */
export function messagesSaid(deps: MessagesSaidDeps): MessagesSaid {
  let hearers = 0;
  deps.events.subscribe((event) => {
    // Only while a hook hears messages is anyone there to decide the wake.
    if (event.type === "MessageSaid" && hearers > 0) deps.wakes.wakeUndecided(event.message.id);
  });
  return {
    subscribe(handler) {
      hearers += 1;
      const unlisten = deps.recording.listen();
      const unsubscribe = deps.events.subscribe(async (event) => {
        if (event.type !== "MessageSaid") return;
        // The hook still reads the platform's event, which the adapter holds
        // while it delivers the message, and Chats never sees.
        const heard = deps.recording.heard(event.via.channel, event.message.id);
        if (!heard) {
          // Handed to nobody, as while a hook is being swapped: nothing will
          // decide its wake, so it stands decided as a message no agent
          // answered.
          deps.wakes.wakeDecided(event.message.id);
          return;
        }
        const seat = await seatOf(deps, event, heard);
        const recorded: SaidInboundEvent = {
          ...heard,
          recorded: { chatRecordId: seat, messageId: String(event.message.id) },
        };
        await handler(recorded);
      });
      let left = false;
      return () => {
        if (left) return;
        left = true;
        hearers -= 1;
        unsubscribe();
        unlisten();
      };
    },
    decided: async (recorded) => deps.wakes.wakeDecided(Number(recorded.messageId)),
  };
}

/**
 * The seat of the account that heard `event`'s message, in its chat, opened
 * when it holds none, by its session's id. A chat starts answered by main;
 * its own agent, when it has one, was set through its settings.
 */
async function seatOf(
  deps: MessagesSaidDeps,
  event: MessageSaid,
  heard: InboundEvent,
): Promise<string> {
  const { place, at } = event.message;
  const kind = deps.chats.find(place.chat.id)?.kind ?? "group";
  const threadName = heard.message.thread?.name;
  const seat = await deps.seats.ensureChannelChat({
    channel: event.via.channel,
    threadId: heard.message.chatId,
    ...(heard.message.parentChatId === undefined
      ? {}
      : { parentThreadId: heard.message.parentChatId }),
    ...(threadName === undefined ? {} : { threadName }),
    threadType: kind === "dm" ? "private" : "group",
    agentName: "main",
    chat: place.chat,
    accountId: event.via.account.id,
  });
  await deps.seats.advanceActivity(seat.id, at);
  return seat.id;
}
