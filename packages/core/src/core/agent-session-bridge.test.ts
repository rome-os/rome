import { EventEmitter } from "node:events";
import { context } from "@opentelemetry/api";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, StreamAgentMessage } from "@rome-os/app-runtime";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import type { AgentSession, AgentSessionManager, AgentTurnHandle } from "./agent-session.js";
import { AgentSessionBridge } from "./agent-session-bridge.js";
import { AgentInputQueue } from "./agent-input-queue.js";
import { createTestDb } from "../test/helpers.js";
import { WebChatRepository, conversationPlatformMessageId } from "../db/repositories/webchat.js";
import type { ConnectionTalkRouter } from "../connections/talk-router.js";

class FakeChild extends EventEmitter {
  connected = true;
  sent: unknown[] = [];

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
}

describe("AgentSessionBridge turn routing", () => {
  it("admits multiple persisted inputs before completion and gives their run one delivery owner", async () => {
    const test = createTestDb();
    const repository = new WebChatRepository(test.db);
    const conversation = await repository.ensureChannelConversation({
      channel: "synthetic",
      threadId: "dm",
      threadType: "private",
      agentName: "main",
    });
    for (const platformMessageId of ["a", "b"]) {
      await repository.addConversationMessage({
        sessionId: conversation.id,
        role: "user",
        content: "[]",
        platformMessageId,
      });
    }
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handle = {
      turnId: "run-one",
      turnContext: context.active(),
      events: (async function* () {
        yield {
          type: "turn_start",
          turnId: "run-one",
          sessionId: "provider",
          userPrompt: "a",
        } as const;
        yield { type: "text_delta", content: "preview" } as const;
        await gate;
        yield { type: "text", content: "answer", turnPhase: "final" } as const;
        yield { type: "result", content: "answer" } as const;
      })(),
    } as AgentTurnHandle;
    const steer = rs.fn(async (_input: { inputId: string; text: string }) => "accepted" as const);
    const queue = new AgentInputQueue(
      () => handle,
      () => ({ steerUserInput: steer }),
      () => {},
    );
    const session = {
      key: { agentName: "main", channelThreadKey: "synthetic:dm" },
      sessionId: "provider",
      romeSessionId: conversation.id,
      submitInput: queue.submit.bind(queue),
    } as unknown as AgentSession;
    const delivered = rs.fn(async () => []);
    const createRunDelivery = rs.fn(async () => ({
      append() {},
      complete() {},
      finish: delivered,
      async stop() {},
    }));
    const router = { feature: () => ({}), createRunDelivery } as unknown as ConnectionTalkRouter;
    const child = new FakeChild();
    const bridge = new AgentSessionBridge(
      { acquire: async () => session } as unknown as AgentSessionManager,
      repository,
      undefined,
      undefined,
      router,
    );
    bridge.attach(child as unknown as ChildProcess);
    try {
      for (const id of ["a", "b"]) {
        child.emit("message", {
          type: "rpc_request",
          reqId: id,
          method: "agent.session.runTurn",
          params: {
            admissionOnly: true,
            key: session.key,
            input: { prompt: id },
            platformMessageId: id,
            init: {
              romeSessionId: conversation.id,
              threadContext: {
                channel: "synthetic",
                connectionId: "connection",
                threadId: "dm",
                threadType: "private",
                senderBondLevel: "guardian",
              },
            },
          },
        });
      }
      await rs.waitFor(() =>
        expect(
          child.sent.filter((message) => (message as { type: string }).type === "rpc_response"),
        ).toHaveLength(2),
      );
      expect(createRunDelivery).toHaveBeenCalledTimes(1);
      expect(delivered).not.toHaveBeenCalled();
      queue.ready("run-one");
      await rs.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
      expect(steer.mock.calls[0][0]).toMatchObject({
        inputId: conversationPlatformMessageId(conversation.id, "b"),
        text: "b",
      });
      finish();
      await rs.waitFor(() => expect(delivered).toHaveBeenCalledWith("answer"));
    } finally {
      finish();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      test.close();
    }
  });

  it("routes a started provider conversation to its exact interruptible turn", async () => {
    let startTurn!: () => void;
    const start = new Promise<void>((resolve) => {
      startTurn = resolve;
    });
    let finishTurn!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const interrupt = rs.fn(async () => undefined);
    const events = (async function* (): AsyncIterable<StreamAgentMessage> {
      await start;
      yield {
        type: "turn_start",
        turnId: "turn-1",
        sessionId: "session-1",
        userPrompt: "hello",
      };
      await finish;
      yield { type: "turn_end", turnId: "turn-1", status: "completed", durationMs: 1 };
    })();
    const session = {
      key: { agentName: "main", channelThreadKey: "discord:channel-1" },
      sessionId: "session-1",
      romeSessionId: "channel:discord:channel-1",
      sendTurn: () => ({ turnId: "turn-1", events, interrupt }) as unknown as AgentTurnHandle,
    } as unknown as AgentSession;
    const manager = {
      acquire: async () => session,
      peek: () => session,
    } as unknown as AgentSessionManager;
    const turns = createAgentTurnStreamRegistry();
    const child = new FakeChild();
    new AgentSessionBridge(manager, undefined, undefined, turns).attach(
      child as unknown as ChildProcess,
    );

    child.emit("message", {
      type: "rpc_request",
      reqId: "request-1",
      method: "agent.session.runTurn",
      params: {
        key: session.key,
        input: { prompt: "hello" },
        init: {
          threadContext: {
            channel: "discord",
            connectionId: "connection:discord",
            threadId: "channel-1",
            channelUserId: "user-1",
          },
        },
      },
    });

    const ref = {
      connectionId: "connection:discord",
      conversationId: "channel-1" as ConversationId,
    };
    await rs.waitFor(() =>
      expect(child.sent).toContainEqual(expect.objectContaining({ type: "rpc_response" })),
    );
    expect(turns.getActiveByConversation(ref)).toBeUndefined();

    startTurn();
    await rs.waitFor(() => expect(turns.getActiveByConversation(ref)?.turnId).toBe("turn-1"));
    const active = turns.getActiveByConversation(ref)!;
    expect(active.initiatorId).toBe("user-1");

    await active.interrupt?.("chat-stop");
    expect(interrupt).toHaveBeenCalledWith("chat-stop");

    finishTurn();
    await rs.waitFor(() => expect(turns.getActiveByConversation(ref)).toBeUndefined());
  });
});
