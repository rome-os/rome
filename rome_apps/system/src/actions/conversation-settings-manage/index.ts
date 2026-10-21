import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
  ChatId,
  ChatSettingField,
  ChatSettingsControl,
  PartialChatSettings,
} from "@rome-os/app-runtime";

interface Input {
  op: "list" | "get" | "set" | "reset";
  connectionId?: string;
  chatId?: string;
  /** What routines saved before the rename name the chat. */
  conversationId?: string;
  query?: string;
  settings?: PartialChatSettings;
  clear?: ChatSettingField[];
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const settings = (deps.chatSettings ?? deps.conversationSettings) as
    | ChatSettingsControl
    | undefined;
  if (!settings) throw new Error("conversation_settings_manage requires chatSettings");

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "get", "set", "reset"] },
        connectionId: {
          type: "string",
          description: "Opaque connectionId returned by list or present in channel context.",
        },
        chatId: {
          type: "string",
          description: "Opaque chatId returned by list or present in channel context.",
        },
        query: { type: "string", description: "Optional list search." },
        settings: {
          type: "object",
          description: "Explicit provider-neutral overrides for op=set.",
        },
        clear: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "enabled",
              "activation.mode",
              "activation.botMessages",
              "activation.whenOthersMentioned",
              "replies.placement",
              "routing.agentName",
            ],
          },
        },
      },
      required: ["op"],
      additionalProperties: false,
    },
    async execute(raw): Promise<ActionResult> {
      const input = raw as unknown as Input;
      if (input.op === "list") {
        return {
          status: "ok",
          data: await settings.list({
            connectionId: input.connectionId,
            query: input.query,
            limit: 100,
          }),
        };
      }
      const chatId = input.chatId ?? input.conversationId;
      if (!input.connectionId || chatId === undefined) {
        return { status: "error", error: "connectionId and chatId are required" };
      }
      const ref = { connectionId: input.connectionId, chatId: chatId as ChatId };
      if (input.op === "get") return { status: "ok", data: await settings.get(ref) };
      if (input.op === "reset") {
        return {
          status: "ok",
          data: await settings.reset({ ref, actor: { kind: "system", id: "system-action" } }),
        };
      }
      return {
        status: "ok",
        data: await settings.update({
          ref,
          set: input.settings ?? {},
          clear: input.clear ?? [],
          actor: { kind: "system", id: "system-action" },
        }),
      };
    },
  };
}
