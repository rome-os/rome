// What Chats offers apps. An app's action worker runs in its own process, and
// Rome's accounts, chat settings and agent names live in the main process, so
// the worker reaches them through these calls.

import type {
  Account,
  ChatId,
  ChatRef,
  ChatSettingsControl,
  ChannelsService,
  ListChatSettingsInput,
  MessageReceipt,
  OutgoingMessage,
  ResetChatSettingsInput,
  ThreadContext,
  UpdateChatSettingsInput,
} from "@rome-os/app-runtime";
import { z } from "zod";
import type { SessionActor } from "../access/session-actor.js";
import { parseWorkerCallParams } from "../lib/worker-call-params.js";
import type { AgentNamesService } from "../chats/accounts/agent-names.js";
import { dashboardCallerOf, webchatCaller } from "../webchat/dashboard-account.js";

// An app names one of Rome's accounts, or a channel by its name.
const AccountOrChannel = z.union([
  z.string().min(1),
  z.object({ platform: z.string().min(1), id: z.string().min(1) }).strict(),
]);

const SendParams = z.object({
  channel: AccountOrChannel,
  chatId: z.string(),
  message: z.custom<OutgoingMessage>((val) => typeof val === "object" && val !== null, {
    message: "message must be an object",
  }),
});

// `query` reads the channel's own `messages`, which names no Connection, so a
// request naming one is refused rather than answered from another account.
const QueryParams = z
  .object({
    channel: AccountOrChannel,
    chatId: z.string().optional(),
    since: z.string().datetime().optional(),
    after: z.string().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const AgentNamesResolveParams = z.object({ name: z.string().min(1) }).strict();

const ChatRefParams = z.object({
  ref: z.object({ connectionId: z.string().min(1), chatId: z.string() }),
});
const ChatSettingsInput = z.custom<
  UpdateChatSettingsInput | ResetChatSettingsInput | ListChatSettingsInput
>((value) => typeof value === "object" && value !== null);

/** The action behind a worker's call, as the worker boundary captured it. */
export interface WorkerCaller {
  callerActionContext?: {
    actor?: SessionActor;
    channelContext?: ThreadContext;
    agentName?: string;
  };
}

export interface ChatWorkerCallsDeps {
  /** How a worker's actions send and read on Rome's accounts. */
  channelsService: ChannelsService;
  chatSettings: ChatSettingsControl;
  /** How `system:send_message` turns an agent's name into its id. */
  agentNames: AgentNamesService;
  /**
   * Takes a send into a Concierge chat that the Concierge did not make, and
   * answers its receipt; null lets the send go on. Absent, every send goes on.
   */
  intoConciergeChat?: (
    target: Account | string,
    chatId: string,
    message: OutgoingMessage,
    agentName: string | undefined,
  ) => Promise<MessageReceipt | null>;
}

/** The chat calls an app's worker makes, keyed by method name. */
export function chatWorkerCalls(
  deps: ChatWorkerCallsDeps,
): Record<string, (params: unknown, caller?: WorkerCaller) => Promise<unknown>> {
  const { channelsService, chatSettings } = deps;
  return {
    "channels.list": async () => channelsService.list(),
    "channels.send": async (params, caller) => {
      const { channel, chatId, message } = parseWorkerCallParams(
        "channels.send",
        SendParams,
        params,
      );
      // The dashboard chat writes only where the calling action's person may.
      return await webchatCaller.run(dashboardCallerOf(caller?.callerActionContext), async () => {
        // Only the Concierge writes in a Concierge chat: another agent's or an
        // app's send there wakes it instead, once the caller may write there.
        const taken = await deps.intoConciergeChat?.(
          channel,
          chatId,
          message,
          caller?.callerActionContext?.agentName,
        );
        return taken ?? (await channelsService.send(channel, chatId as ChatId, message));
      });
    },
    "channels.query": async (params, caller) => {
      const { channel, chatId, since, after, limit } = parseWorkerCallParams(
        "channels.query",
        QueryParams,
        params,
      );
      // The dashboard chat reads as the person accountable for the calling
      // action's turn, in the chat it runs in.
      return await webchatCaller.run(dashboardCallerOf(caller?.callerActionContext), () =>
        channelsService.query(channel, {
          ...(chatId ? { chatId: chatId as ChatId } : {}),
          ...(since ? { since: new Date(since) } : {}),
          ...(after ? { after } : {}),
          ...(limit ? { limit } : {}),
        }),
      );
    },
    "agentNames.resolve": async (params) => {
      const { name } = parseWorkerCallParams("agentNames.resolve", AgentNamesResolveParams, params);
      return deps.agentNames.resolve(name);
    },
    "chatSettings.list": async (params) =>
      chatSettings.list(
        parseWorkerCallParams(
          "chatSettings.list",
          ChatSettingsInput,
          params,
        ) as ListChatSettingsInput,
      ),
    "chatSettings.get": async (params) => {
      const { ref } = parseWorkerCallParams("chatSettings.get", ChatRefParams, params);
      return chatSettings.get(ref as ChatRef);
    },
    "chatSettings.update": async (params) =>
      chatSettings.update(
        parseWorkerCallParams(
          "chatSettings.update",
          ChatSettingsInput,
          params,
        ) as UpdateChatSettingsInput,
      ),
    "chatSettings.reset": async (params) =>
      chatSettings.reset(
        parseWorkerCallParams(
          "chatSettings.reset",
          ChatSettingsInput,
          params,
        ) as ResetChatSettingsInput,
      ),
  };
}
