import { expect, it, rs } from "@rstest/core";
import { buildConciergeTools } from "./tools.js";
import type { ConciergeService } from "./service.js";
import type { SessionToolContext } from "../core/session-tools.js";
import {
  claimTaskInputActor,
  taskInputActor,
  withTaskInputActor,
} from "../webchat/task-input-actor.js";

for (const askingDeviceId of [undefined, "synthetic-device"] as const) {
  it(`chat_send keeps host identity and ${askingDeviceId ? "the asking device" : "no device"}, without a model actor field`, async () => {
    const guardian = {
      kind: "guardian" as const,
      userId: "synthetic-seat",
      via: "cookie" as const,
    };
    const rows = new Map([
      [
        "source",
        { id: "source", agentName: "core:concierge", ownerKey: "guardian", archivedAt: null },
      ],
      [
        "target",
        {
          id: "target",
          name: "Task",
          triggerKind: "concierge",
          ownerKey: "guardian",
          archivedAt: null,
        },
      ],
    ]);
    const repo = {
      getSession: async (id: string) => rows.get(id) ?? null,
      getTurnChatMessages: async () => [],
      setAskingDevice: rs.fn(async () => {}),
    };
    let received: unknown;
    const send = rs.fn(async (_place, body, as) => {
      const claim = claimTaskInputActor("target", body, as)!;
      received = await taskInputActor(claim, repo as never, async () => "source");
      return { ok: true };
    });
    const resume = rs.fn(async () => {});
    const service = {
      ownerOfChat: async () => "guardian",
      promptsHandedOn: () => [],
      carriedReport: () => undefined,
      deps: {
        webchatRepo: repo,
        messages: {},
        tasks: {
          repo: {
            findBySession: async () => ({ id: "task" }),
            resume,
            getWithChat: async () => ({ conciergeChat: { id: "source" } }),
          },
        },
      },
      dashboard: { send },
    } as unknown as ConciergeService;
    const context: SessionToolContext = {
      agentName: "core:concierge",
      sessionId: "source-session",
      channelThreadKey: "webchat:source",
      isSubagent: false,
      getTurnId: () => "source-turn",
      getThreadContext: () => ({
        channel: "webchat",
        threadId: "source",
        threadType: "private",
        ...(askingDeviceId ? { askingDeviceId } : {}),
      }),
      getTurnPushLevel: () => undefined,
      getTurnReportedTask: () => undefined,
      withTaskInput: (target, body, fn) =>
        withTaskInputActor(
          {
            agentName: "core:concierge",
            chatId: "source",
            turnId: "source-turn",
            actor: guardian,
            audience: "private",
            isCurrent: () => true,
          },
          target,
          body,
          fn,
        ),
    };
    const tools = await buildConciergeTools(service, context);
    const tool = tools.find((tool) => tool.name === "chat_send")!;
    expect(tool.inputSchema).not.toHaveProperty("properties.actor");
    const result = await tool.handler({ chatId: "target", text: "inspect public metadata" });
    expect(result.isError).toBeFalsy();
    expect(resume).toHaveBeenCalledWith("task");
    expect(send).toHaveBeenCalledTimes(1);
    expect(received).toEqual(guardian);
    if (askingDeviceId) expect(repo.setAskingDevice).toHaveBeenCalledWith("target", askingDeviceId);
    else expect(repo.setAskingDevice).not.toHaveBeenCalled();
  });
}
