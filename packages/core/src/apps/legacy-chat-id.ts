/**
 * @rome-os/app-runtime 0.8 renamed a chat's id from `conversationId` to
 * `chatId`, and a message's `parentConversationId` to `parentChatId`. An app
 * written for 0.7 still reads and writes the old names, so what the host hands
 * an app carries both, and what an app hands the host is read under either.
 *
 * TODO(0.9): remove, with its uses.
 */

import type {
  Channel,
  ChannelMessage,
  ChannelMessageQuery,
  ChannelSend,
  ChannelsService,
  ChatDescriptor,
  ChatId,
  ChatRef,
  ChatSettingsControl,
  ChatSettingsSnapshot,
  ChatStopHandler,
  MessageReceipt,
} from "@rome-os/app-runtime";

/** `value` with its chat id under `chatId` alone, read from `conversationId`
 *  when the app named it only that. The worker RPC rejects keys it does not
 *  know, so the old name never travels on. */
function chatIdIn<T extends { chatId?: ChatId }>(value: T): T {
  if (!("conversationId" in value)) return value;
  const { conversationId, ...rest } = value as T & { conversationId?: ChatId };
  return { ...rest, chatId: value.chatId ?? conversationId } as T;
}

/** A message an app hands back, with its ids under the new names alone. */
function messageIn(message: ChannelMessage): ChannelMessage {
  const { parentConversationId, ...rest } = chatIdIn(message) as ChannelMessage & {
    parentConversationId?: ChatId;
  };
  const parentChatId = rest.parentChatId ?? parentConversationId;
  return parentChatId ? { ...rest, parentChatId } : rest;
}

function refOut(ref: ChatRef): ChatRef {
  return { ...ref, conversationId: ref.chatId } as ChatRef;
}

function messageOut(message: ChannelMessage): ChannelMessage {
  return {
    ...message,
    conversationId: message.chatId,
    ...(message.parentChatId ? { parentConversationId: message.parentChatId } : {}),
  } as ChannelMessage;
}

function receiptOut(receipt: MessageReceipt): MessageReceipt {
  return { ...receipt, conversationId: receipt.chatId } as MessageReceipt;
}

function descriptorOut(descriptor: ChatDescriptor): ChatDescriptor {
  return {
    ...descriptor,
    ref: refOut(descriptor.ref),
    ...(descriptor.parent ? { parent: refOut(descriptor.parent) } : {}),
  };
}

function snapshotOut(snapshot: ChatSettingsSnapshot): ChatSettingsSnapshot {
  return {
    ...snapshot,
    conversation: descriptorOut(snapshot.conversation),
    ...(snapshot.inheritedFrom ? { inheritedFrom: refOut(snapshot.inheritedFrom) } : {}),
  };
}

/** The chat settings as an app gets them. */
export function legacyChatIdSettings(control: ChatSettingsControl): ChatSettingsControl {
  return {
    async list(input) {
      const page = await control.list(input);
      return {
        ...page,
        items: page.items.map((item) => ({ ...item, snapshot: snapshotOut(item.snapshot) })),
      };
    },
    get: async (ref) => snapshotOut(await control.get(chatIdIn(ref))),
    update: async (input) =>
      snapshotOut(await control.update({ ...input, ref: chatIdIn(input.ref) })),
    reset: async (input) =>
      snapshotOut(await control.reset({ ...input, ref: chatIdIn(input.ref) })),
  };
}

/** The stop handler as a hook gets it. */
export function legacyChatIdStop(stop: ChatStopHandler): ChatStopHandler {
  return (input) => stop({ ...input, ref: chatIdIn(input.ref) });
}

/** The channels service as an app action gets it. Every other member,
 *  including the removed ones that answer with their migration, is read from
 *  the service itself. */
export function legacyChatIdChannelsService(service: ChannelsService): ChannelsService {
  const wrapped = Object.create(service) as ChannelsService;
  Object.defineProperties(wrapped, {
    send: {
      value: async (...[channel, chatId, message]: Parameters<ChannelsService["send"]>) =>
        receiptOut(await service.send(channel, chatId, message)),
    },
    query: {
      value: async (channel: string, query?: ChannelMessageQuery) =>
        (await service.query(channel, query && chatIdIn(query))).map(messageOut),
    },
  });
  return wrapped;
}

/**
 * A channel's send port as an app gets it. It reads every other member,
 * including those core adds beyond the SDK's, from the port itself, so a
 * member the port answers live stays live.
 */
function sendOut(send: ChannelSend): ChannelSend {
  const wrapped = Object.create(send) as ChannelSend;
  Object.defineProperties(wrapped, {
    send: {
      value: async (chatId: ChatId, message: Parameters<ChannelSend["send"]>[1]) =>
        receiptOut(await send.send(chatId, message)),
    },
    activity: {
      get: () => {
        const activity = send.activity;
        return activity
          ? {
              begin: (input: { chatId: ChatId; messageId?: string }) =>
                activity.begin(chatIdIn(input)),
            }
          : activity;
      },
    },
  });
  return wrapped;
}

/** Channels as a hook gets them. */
export function legacyChatIdChannels<C extends Channel>(channels: readonly C[]): C[] {
  return channels.map((channel) => {
    const { inbound, send } = channel;
    return {
      ...channel,
      send: send && sendOut(send),
      inbound: inbound && {
        subscribe: (handler) =>
          inbound.subscribe((event) =>
            handler({ ...event, message: messageOut(event.message), ref: refOut(event.ref) }),
          ),
        get media() {
          const media = inbound.media;
          return (
            media && {
              materialize: (message: ChannelMessage) => media.materialize(messageIn(message)),
            }
          );
        },
      },
    } as C;
  });
}
