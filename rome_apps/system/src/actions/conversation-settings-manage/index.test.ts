import { describe, expect, it, rs } from "@rstest/core";
import type {
  ActionConfig,
  AppActionRuntimeDeps,
  ChatSettingsControl,
  ChatSettingsSnapshot,
} from "@rome-os/app-runtime";
import { createAction } from "./index.js";

const config: ActionConfig = {
  name: "conversation_settings_manage",
  type: "system",
  description: "Manage chat settings",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "write",
};

describe("conversation_settings_manage", () => {
  it("reads a chat a routine saved under conversationId", async () => {
    const get = rs.fn<ChatSettingsControl["get"]>(async () => ({}) as ChatSettingsSnapshot);
    const chatSettings = {
      get,
      list: async () => ({ items: [] }),
      update: async () => ({}) as ChatSettingsSnapshot,
      reset: async () => ({}) as ChatSettingsSnapshot,
    } satisfies ChatSettingsControl;
    const action = createAction(config, { chatSettings } as unknown as AppActionRuntimeDeps);

    const result = await action.execute({ op: "get", connectionId: "bot", conversationId: "dm" });

    expect(result.status).toBe("ok");
    expect(get).toHaveBeenCalledWith({ connectionId: "bot", chatId: "dm" });
  });
});
