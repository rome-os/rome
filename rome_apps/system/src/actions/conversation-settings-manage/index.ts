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
        conversationId: {
          type: "string",
          description: "Opaque conversationId returned by list or present in channel context.",
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
      if (!input.connectionId || input.conversationId === undefined) {
        return { status: "error", error: "connectionId and conversationId are required" };
      }
      const ref = {
        connectionId: input.connectionId,
        conversationId: input.conversationId as ChatId,
      };
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
