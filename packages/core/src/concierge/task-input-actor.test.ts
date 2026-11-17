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
      widgets: "card",
      getTurnId: () => "source-turn",
      getThreadContext: () => ({
        channel: "webchat",
        threadId: "source",
        threadType: "private",
        ...(askingDeviceId ? { askingDeviceId } : {}),
      }),
      getTurnPushLevel: () => undefined,
      getTurnReportedTask: () => undefined,
      captureTaskInput: () => (target, body, fn) =>
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

for (const pauseAt of ["lookup", "asking-device"] as const) {
  for (const initial of ["autonomous", "guardian", "visitor"] as const) {
    it(`does not borrow a newer guardian for ${initial} work after async ${pauseAt} setup`, async () => {
      const { romeToolPorts } = await import("../core/rome-tool-ports.js");
      let context!: SessionToolContext;
      let actor: { kind: string; userId?: string; accountId?: string; email?: string } | undefined =
        initial === "autonomous"
          ? undefined
          : initial === "guardian"
            ? { kind: "guardian", userId: "synthetic-seat" }
            : { kind: "visitor", accountId: "synthetic-v", email: "v@example.invalid" };
      const owner = initial === "visitor" ? "visitor:synthetic-v" : "guardian";
      let turnId = "autonomous";
      const thread = {
        channel: "webchat",
        threadId: "source",
        threadType: "private" as const,
        askingDeviceId: "synthetic-device",
      };
      const ports = romeToolPorts({
        actionRegistry: {} as never,
        actionEngine: {} as never,
        sessionTools: async (value) => {
          context = value;
          return [];
        },
      });
      await ports.sessionTools.forTurn(
        {
          agentName: "core:concierge",
          continuityKey: "webchat:source",
          sessionId: "source",
          isSubagent: false,
          actions: [],
          widgets: "card",
          turnId: () => turnId,
          live: () => true,
          threadContext: () => thread,
          sharedContext: () => undefined,
          pushLevel: () => undefined,
          actor: () => actor,
          audience: () => "private",
          reportedTask: () => undefined,
          inTurn: (fn) => fn(),
        },
        true,
      );
      const rows = new Map([
        [
          "source",
          { id: "source", agentName: "core:concierge", ownerKey: owner, archivedAt: null },
        ],
        [
          "target",
          {
            id: "target",
            name: "Task",
            triggerKind: "concierge",
            ownerKey: owner,
            archivedAt: null,
          },
        ],
      ]);
      let setup!: () => void;
      const started = new Promise<void>((resolve) => {
        setup = resolve;
      });
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const send = rs.fn(async (_place, body, as) => {
        const claim = claimTaskInputActor("target", body, as);
        if (initial === "autonomous") expect(claim).toBeUndefined();
        if (claim) await taskInputActor(claim, repo as never, async () => "source");
        return { ok: true };
      });
      let didPause = false;
      const repo = {
        getSession: async (id: string) => {
          if (pauseAt === "lookup" && id === "target" && !didPause) {
            didPause = true;
            setup();
            await paused;
          }
          return rows.get(id) ?? null;
        },
        getTurnChatMessages: async () => [],
        setAskingDevice: async () => {
          if (pauseAt === "asking-device") {
            setup();
            await paused;
          }
        },
      };
      const service = {
        ownerOfChat: async () => owner,
        promptsHandedOn: () => [],
        carriedReport: () => undefined,
        deps: {
          webchatRepo: repo,
          messages: {},
          tasks: {
            repo: {
              findBySession: async () => ({ id: "task" }),
              resume: async () => {},
              getWithChat: async () => ({ conciergeChat: { id: "source" } }),
            },
          },
        },
        dashboard: { send },
      } as unknown as ConciergeService;
      const tools = await buildConciergeTools(service, context);
      const pending = tools
        .find((tool) => tool.name === "chat_send")!
        .handler({
          chatId: "target",
          text: "autonomous work must not gain identity",
        });
      await started;
      actor = { kind: "guardian", userId: "synthetic-seat" };
      turnId = "new-guardian-turn";
      resume();
      const result = await pending;
      if (initial === "autonomous") {
        expect(result.isError).toBeFalsy();
        expect(send).toHaveBeenCalledTimes(1);
      } else {
        expect(result.isError).toBe(true);
        expect(send).not.toHaveBeenCalled();
      }
    });
  }
}
