import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChatId, ChatRepository, StreamAgentEvent } from "@rome-os/app-runtime";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import type {
  AgentSession,
  AgentSessionInit,
  AgentSessionManager,
  AgentTurnHandle,
} from "./agent-session.js";
import { Pacer } from "../channels/delivery/pacer.js";
import { type ReplyStream, ReplyStreams, type ReplyTarget } from "../channels/delivery/streams.js";
import { DeliveryFailure, type DeliveryTransport, plainText } from "../channels/delivery/types.js";
import { systemClock } from "../lib/clock.js";
import { AgentSessionBridge } from "./agent-session-bridge.js";
import { IpcRpc, createChildProcessTransport } from "../actions/ipc.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { createTestDb } from "../test/helpers.js";

class FakeChild extends EventEmitter {
  connected = true;
  sent: unknown[] = [];

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
}

describe("AgentSessionBridge turn routing", () => {
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
    const events = (async function* (): AsyncIterable<StreamAgentEvent> {
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
      conversation: { origin: "named", id: "channel:discord:channel-1" },
      sendTurn: () => ({ turnId: "turn-1", events, interrupt }) as unknown as AgentTurnHandle,
    } as unknown as AgentSession;
    const manager = {
      acquire: async () => session,
      peek: () => session,
    } as unknown as AgentSessionManager;
    const turns = createAgentTurnStreamRegistry();
    const child = new FakeChild();
    new AgentSessionBridge(manager, undefined, undefined, turns).attach(
      new IpcRpc(createChildProcessTransport(child as unknown as ChildProcess), "main"),
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
      chatId: "channel-1" as ChatId,
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

describe("AgentSessionBridge conversation", () => {
  it("records a turn with no caller conversation in the one the session recorded", async () => {
    const testDb = createTestDb();
    try {
      const repo = new WebChatRepository(testDb.db);
      await repo.ensureRomeSession({
        id: "child-chat",
        type: "subagent",
        name: "researcher: Parent",
        agentName: "researcher",
      });
      type TurnRef = { romeSessionId?: string; romeSessionType?: string };
      const sent: TurnRef[] = [];
      const session = {
        key: { agentName: "main", channelThreadKey: "discord:channel-1" },
        sessionId: "session-1",
        conversation: {
          origin: "recorded" as const,
          id: "child-chat",
          name: "researcher: Parent",
          type: "subagent",
        },
        sendTurn: (_input: unknown, options: TurnRef) => {
          sent.push({
            romeSessionId: options.romeSessionId,
            romeSessionType: options.romeSessionType,
          });
          return {
            turnId: "turn-1",
            events: (async function* (): AsyncIterable<StreamAgentEvent> {
              yield {
                type: "turn_start",
                turnId: "turn-1",
                sessionId: "session-1",
                userPrompt: "follow up",
                agent: "main",
              };
              yield { type: "result", content: "Done", agent: "main" };
            })(),
            interrupt: async () => undefined,
          } as unknown as AgentTurnHandle;
        },
      } as unknown as AgentSession;
      const manager = {
        acquire: async () => session,
        peek: () => session,
      } as unknown as AgentSessionManager;
      const child = new FakeChild();
      new AgentSessionBridge(manager, repo).attach(
        new IpcRpc(createChildProcessTransport(child as unknown as ChildProcess), "main"),
        child as unknown as ChildProcess,
      );

      child.emit("message", {
        type: "rpc_request",
        reqId: "request-1",
        method: "agent.session.runTurn",
        params: {
          key: session.key,
          input: { prompt: "follow up" },
          init: {},
        },
      });

      await rs.waitFor(() =>
        expect(sent).toEqual([{ romeSessionId: "child-chat", romeSessionType: "subagent" }]),
      );
      await rs.waitFor(async () => {
        const roles = (await repo.getMessages("child-chat")).map((m) => m.role);
        expect(roles).toContain("user");
      });
    } finally {
      testDb.close();
    }
  });
});

describe("AgentSessionBridge working dir", () => {
  const summonCall = { actionName: "system:summon", agentName: "main" };
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(callerWorkingDirs: Record<string, string> = {}) {
    const projectsRoot = realpathSync(mkdtempSync(join(tmpdir(), "rome-bridge-projects-")));
    tempDirs.push(projectsRoot);
    mkdirSync(join(projectsRoot, "landingpage"));
    const acquired: AgentSessionInit[] = [];
    const session = {
      key: { agentName: "coder", channelThreadKey: "coder:1" },
      sessionId: "summoned-1",
      sendTurn: () =>
        ({
          turnId: "turn-1",
          events: (async function* (): AsyncIterable<StreamAgentEvent> {})(),
          interrupt: async () => undefined,
        }) as unknown as AgentTurnHandle,
    } as unknown as AgentSession;
    const manager = {
      acquire: async (_key: unknown, init: AgentSessionInit) => {
        acquired.push(init);
        return session;
      },
      acquireBySessionId: async (_id: string, _agent: string, init: AgentSessionInit) => {
        acquired.push(init);
        return session;
      },
      peek: () => undefined,
      findWorkingDirBySessionId: (id: string) => callerWorkingDirs[id],
    } as unknown as AgentSessionManager;
    const child = new FakeChild();
    new AgentSessionBridge(manager, undefined, undefined, undefined, projectsRoot).attach(
      new IpcRpc(createChildProcessTransport(child as unknown as ChildProcess), "main"),
      child as unknown as ChildProcess,
    );

    let seq = 0;
    const runTurn = async (params: Record<string, unknown>) => {
      const reqId = `request-${++seq}`;
      child.emit("message", {
        type: "rpc_request",
        reqId,
        method: "agent.session.runTurn",
        params: { key: session.key, input: { prompt: "hi" }, ...params },
      });
      let response: { result?: unknown; error?: string } | undefined;
      await rs.waitFor(() => {
        response = child.sent.find(
          (m) =>
            (m as { type: string; reqId?: string }).type === "rpc_response" &&
            (m as { reqId?: string }).reqId === reqId,
        ) as typeof response;
        expect(response).toBeDefined();
      });
      return response!;
    };
    return { projectsRoot, acquired, runTurn };
  }

  it("opens the run in a requested project inside the projects root", async () => {
    const { projectsRoot, acquired, runTurn } = setup();

    const relative = await runTurn({ init: { workingDir: "landingpage" } });
    const absolute = await runTurn({ init: { workingDir: join(projectsRoot, "landingpage") } });

    expect(relative.error).toBeUndefined();
    expect(absolute.error).toBeUndefined();
    expect(acquired.map((init) => init.workingDir)).toEqual([
      join(projectsRoot, "landingpage"),
      join(projectsRoot, "landingpage"),
    ]);
  });

  it("refuses a requested working dir outside the projects root without opening a session", async () => {
    const { acquired, runTurn } = setup();

    const outside = await runTurn({ init: { workingDir: tmpdir() } });
    const traversal = await runTurn({ init: { workingDir: "../elsewhere" } });

    expect(outside.error).toContain("is not inside the projects root");
    expect(traversal.error).toBeDefined();
    expect(acquired).toEqual([]);
  });

  it("inherits the calling session's working dir for a summon run with none requested", async () => {
    const { acquired, runTurn } = setup({ "caller-session": "/profile/projects/site" });

    await runTurn({ actionContext: { ...summonCall, sessionId: "caller-session" } });
    await runTurn({ actionContext: { ...summonCall, sessionId: "closed-session" } });
    await runTurn({});

    expect(acquired.map((init) => init.workingDir)).toEqual([
      "/profile/projects/site",
      undefined,
      undefined,
    ]);
  });

  it("prefers a requested working dir over the calling session's", async () => {
    const { projectsRoot, acquired, runTurn } = setup({
      "caller-session": "/profile/projects/site",
    });

    await runTurn({
      init: { workingDir: "landingpage" },
      actionContext: { ...summonCall, sessionId: "caller-session" },
    });

    expect(acquired.map((init) => init.workingDir)).toEqual([join(projectsRoot, "landingpage")]);
  });

  it("leaves an explicit resume to reopen where its transcript lives", async () => {
    const { acquired, runTurn } = setup({ "caller-session": "/profile/projects/site" });

    await runTurn({
      sessionId: "summoned-1",
      actionContext: { ...summonCall, sessionId: "caller-session" },
    });

    expect(acquired.map((init) => init.workingDir)).toEqual([undefined]);
  });

  it("gives an agent run from any other action no inherited working dir", async () => {
    const { acquired, runTurn } = setup({ "caller-session": "/profile/projects/site" });

    await runTurn({
      actionContext: { actionName: "system:generate_image", sessionId: "caller-session" },
    });

    expect(acquired.map((init) => init.workingDir)).toEqual([undefined]);
  });
});

describe("AgentSessionBridge worker disconnect", () => {
  type IpcMessage = {
    type: string;
    reqId?: string;
    name?: string;
    channelId?: string;
    error?: string;
  };

  /** A turn that runs until the test finishes it or someone interrupts it. */
  function controllableTurn(turnId: string) {
    let end!: (status: "completed" | "interrupted") => void;
    const ended = new Promise<"completed" | "interrupted">((resolve) => {
      end = resolve;
    });
    const interrupt = rs.fn(async (_reason?: string) => end("interrupted"));
    const events = (async function* (): AsyncIterable<StreamAgentEvent> {
      yield { type: "turn_start", turnId, sessionId: "session-1", userPrompt: "hello" };
      const status = await ended;
      yield { type: "turn_end", turnId, status, durationMs: 1 };
    })();
    const handle = { turnId, events, interrupt } as unknown as AgentTurnHandle;
    return { handle, interrupt, finish: () => end("completed") };
  }

  function setup(
    handles: AgentTurnHandle[],
    options: {
      beforeAcquire?: () => Promise<void>;
      webchatRepo?: WebChatRepository;
      romeSessionId?: string;
    } = {},
  ) {
    const queue = [...handles];
    const session = {
      key: { agentName: "main", channelThreadKey: "discord:channel-1" },
      sessionId: "session-1",
      conversation: options.romeSessionId
        ? { origin: "named", id: options.romeSessionId }
        : undefined,
      sendTurn: () => queue.shift()!,
    } as unknown as AgentSession;
    const manager = {
      acquire: async () => {
        await options.beforeAcquire?.();
        return session;
      },
      peek: () => session,
    } as unknown as AgentSessionManager;
    const turns = createAgentTurnStreamRegistry();
    const child = new FakeChild();
    new AgentSessionBridge(manager, options.webchatRepo, undefined, turns).attach(
      new IpcRpc(createChildProcessTransport(child as unknown as ChildProcess), "main"),
      child as unknown as ChildProcess,
    );
    const sent = () => child.sent as IpcMessage[];

    let seq = 0;
    const requestTurn = (params: Record<string, unknown> = {}) => {
      const reqId = `request-${++seq}`;
      child.emit("message", {
        type: "rpc_request",
        reqId,
        method: "agent.session.runTurn",
        params: { key: session.key, input: { prompt: "hello" }, ...params },
      });
      return reqId;
    };
    const response = async (reqId: string) => {
      let found: IpcMessage | undefined;
      await rs.waitFor(() => {
        found = sent().find((m) => m.type === "rpc_response" && m.reqId === reqId);
        expect(found).toBeDefined();
      });
      return found!;
    };
    const turnStreamClosed = (turnId: string) => {
      const opened = sent().find(
        (m) => m.type === "stream_open" && m.name === `agent.turn:${turnId}`,
      );
      return sent().some((m) => m.type === "stream_close" && m.channelId === opened?.channelId);
    };
    const workerGone = (event: "disconnect" | "exit") => {
      child.connected = false;
      child.emit(event);
    };
    return { turns, sent, requestTurn, response, turnStreamClosed, workerGone };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("interrupts a running turn when its worker disconnects", async () => {
    const turn = controllableTurn("turn-1");
    const { turns, requestTurn, response, workerGone } = setup([turn.handle]);

    await response(requestTurn());
    await rs.waitFor(() => expect(turns.get("turn-1")?.finished).toBe(false));

    workerGone("disconnect");

    await rs.waitFor(() => expect(turns.get("turn-1")?.finished).toBe(true));
    expect(turn.interrupt).toHaveBeenCalledTimes(1);
    expect(turn.interrupt).toHaveBeenCalledWith("action worker disconnected");
    expect(turns.get("turn-1")?.messages().at(-1)).toMatchObject({
      type: "turn_end",
      status: "interrupted",
    });
  });

  it("interrupts a running turn when its worker exits", async () => {
    const turn = controllableTurn("turn-1");
    const { requestTurn, response, workerGone } = setup([turn.handle]);

    await response(requestTurn());
    workerGone("exit");

    await rs.waitFor(() =>
      expect(turn.interrupt).toHaveBeenCalledWith("action worker disconnected"),
    );
  });

  it("interrupts a turn whose worker disconnected before the turn started", async () => {
    const turn = controllableTurn("turn-1");
    let acquireStarted = false;
    let releaseAcquire!: () => void;
    const acquireReleased = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    const { requestTurn, workerGone } = setup([turn.handle], {
      beforeAcquire: async () => {
        acquireStarted = true;
        await acquireReleased;
      },
    });

    requestTurn();
    await rs.waitFor(() => expect(acquireStarted).toBe(true));
    workerGone("disconnect");
    releaseAcquire();

    await rs.waitFor(() =>
      expect(turn.interrupt).toHaveBeenCalledWith("action worker disconnected"),
    );
  });

  it("leaves a finished turn alone when its worker later disconnects", async () => {
    const turn = controllableTurn("turn-1");
    const { requestTurn, response, turnStreamClosed, workerGone } = setup([turn.handle]);

    await response(requestTurn());
    turn.finish();
    await rs.waitFor(() => expect(turnStreamClosed("turn-1")).toBe(true));

    workerGone("disconnect");
    await settle();

    expect(turn.interrupt).not.toHaveBeenCalled();
  });

  it("interrupts only the turn still running when a worker with two turns disconnects", async () => {
    const first = controllableTurn("turn-1");
    const second = controllableTurn("turn-2");
    const { requestTurn, response, turnStreamClosed, workerGone } = setup([
      first.handle,
      second.handle,
    ]);

    await response(requestTurn());
    await response(requestTurn());
    first.finish();
    await rs.waitFor(() => expect(turnStreamClosed("turn-1")).toBe(true));

    workerGone("disconnect");

    await rs.waitFor(() =>
      expect(second.interrupt).toHaveBeenCalledWith("action worker disconnected"),
    );
    expect(first.interrupt).not.toHaveBeenCalled();
  });

  it("interrupts a turn whose message assignment fails, and only once", async () => {
    const turn = controllableTurn("turn-1");
    const webchatRepo = {
      assignConversationMessageTurn: async () => {
        throw new Error("db down");
      },
    } as unknown as WebChatRepository;
    const { sent, requestTurn, response, workerGone } = setup([turn.handle], {
      webchatRepo,
      romeSessionId: "channel:discord:channel-1",
    });

    const result = await response(requestTurn({ platformMessageId: "message-1" }));

    expect(result.error).toContain("db down");
    await rs.waitFor(() => expect(turn.interrupt).toHaveBeenCalledWith("agent turn setup failed"));
    expect(sent().some((m) => m.type === "stream_open")).toBe(false);

    workerGone("disconnect");
    await settle();

    expect(turn.interrupt).toHaveBeenCalledTimes(1);
  });
});

describe("AgentSessionBridge reply streaming", () => {
  const budget = { burst: 100, refillMs: 1, conversationSpacingMs: 0 };
  const policy = {
    mode: "edit",
    editIntervalMs: 0,
    blockWaitMs: 0,
    maxPendingChars: 1000,
  } as const;

  /** A Telegram-like transport that records what it was asked to write. */
  function platform() {
    const written: Array<[string, string, string | undefined]> = [];
    const edits: string[] = [];
    const transport: DeliveryTransport = {
      capabilities: { maxPartLength: 100, edit: true, budget },
      codec: plainText,
      async create(conversation, text, replyTo) {
        written.push([conversation, text, replyTo]);
        return { messageId: `m${written.length}`, chatId: conversation };
      },
      async edit(_receipt, text) {
        edits.push(text);
      },
    };
    return { transport, written, edits };
  }

  /** Runs one turn over the bridge. `on` is the reply streaming setting. */
  function run(
    events: AsyncIterable<StreamAgentEvent>,
    {
      streamReply,
      on = true,
      interrupt,
      replies: replacement,
      transport: own,
      repo,
      named = true,
    }: {
      streamReply: boolean;
      /** A pending promise holds the setting's read open. */
      on?: boolean | Promise<boolean>;
      interrupt?: () => Promise<void>;
      /** A stream to hand out in place of the real one. */
      replies?: ReplyStream;
      /** A platform to write to in place of the one that records. */
      transport?: DeliveryTransport;
      /** The repository the turn and its reply are recorded in. */
      repo?: WebChatRepository;
      /** Whether the caller names the conversation. Otherwise the thread does. */
      named?: boolean;
    },
  ) {
    const recording = platform();
    const { written, edits } = recording;
    const transport = own ?? recording.transport;
    // The host's adapter over the repository.
    const chats =
      repo &&
      ({
        ensureChannelChat: (input) => repo.ensureChannelChat(input),
        recordOutboundMessage: (input) => repo.recordOutboundConversationMessage(input),
      } satisfies Pick<ChatRepository, "ensureChannelChat" | "recordOutboundMessage">);
    const session = {
      key: { agentName: "main", channelThreadKey: "telegram:chat-1" },
      sessionId: "session-1",
      sendTurn: () => ({ turnId: "turn-1", events, interrupt }) as unknown as AgentTurnHandle,
    } as unknown as AgentSession;
    const manager = { acquire: async () => session } as unknown as AgentSessionManager;
    const targets: ReplyTarget[] = [];
    const replies = replacement
      ? ({
          open: async (target: ReplyTarget) => {
            targets.push(target);
            return replacement;
          },
        } as unknown as ReplyStreams)
      : new ReplyStreams({
          streaming: async () => on,
          replies: (channel) =>
            channel === "telegram" ? { transport, pacer: new Pacer(budget, systemClock) } : null,
          clock: systemClock,
          policy,
          ...(chats ? { chats } : {}),
        });
    const turns = createAgentTurnStreamRegistry();
    const child = new FakeChild();
    new AgentSessionBridge(manager, repo, undefined, turns, undefined, replies).attach(
      new IpcRpc(createChildProcessTransport(child as unknown as ChildProcess), "main"),
      child as unknown as ChildProcess,
    );
    child.emit("message", {
      type: "rpc_request",
      reqId: "request-1",
      method: "agent.session.runTurn",
      params: {
        key: session.key,
        input: { prompt: "hi" },
        platformMessageId: "msg-1",
        streamReply,
        init: {
          ...(named ? { romeSessionId: "conversation-1" } : {}),
          threadContext: {
            channel: "telegram",
            connectionId: "c",
            threadId: "chat-1",
            channelUserId: "user-1",
            ...(named ? {} : { romeSessionId: "conversation-1" }),
          },
        },
      },
    });
    const turnEnd = () =>
      child.sent.find((message) => JSON.stringify(message).includes('"type":"turn_end"'));
    const workerGone = () => {
      child.connected = false;
      child.emit("disconnect");
    };
    return { written, edits, turnEnd, turns, targets, workerGone };
  }

  const turnStart: StreamAgentEvent = {
    type: "turn_start",
    turnId: "turn-1",
    sessionId: "session-1",
    userPrompt: "hi",
  };
  const turnEvents = (...events: StreamAgentEvent[]) =>
    (async function* (): AsyncIterable<StreamAgentEvent> {
      yield turnStart;
      yield* events;
    })();
  const answer: StreamAgentEvent[] = [
    { type: "text", content: "hi there", turnPhase: "final" },
    { type: "result", content: "hi there" },
    { type: "turn_end", turnId: "turn-1", status: "completed", durationMs: 1 },
  ];

  it("streams the reply and reports it on turn_end", async () => {
    const { written, turnEnd } = run(turnEvents(...answer), { streamReply: true });

    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(written).toEqual([["chat-1", "hi there", "msg-1"]]);
    expect(JSON.stringify(turnEnd())).toContain(
      JSON.stringify({ status: "delivered", messageIds: ["m1"] }),
    );
  });

  it("leaves the reply to its caller when the run did not ask to stream", async () => {
    const { written, turnEnd } = run(turnEvents(...answer), { streamReply: false });

    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(written).toEqual([]);
    expect(JSON.stringify(turnEnd())).not.toContain("replyDelivery");
  });

  it("leaves the reply to its caller while reply streaming is off, even when the run asked", async () => {
    const { written, turnEnd } = run(turnEvents(...answer), { streamReply: true, on: false });

    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(written).toEqual([]);
    expect(JSON.stringify(turnEnd())).not.toContain("replyDelivery");
  });

  it("keeps the run going when the reply stream throws, and reports a reply it never wrote as failed", async () => {
    const { turnEnd, written } = run(turnEvents(...answer), {
      streamReply: true,
      replies: {
        accept: () => {
          throw new Error("split failed");
        },
        settle: async () => ({ status: "stopped", parts: [] }),
        stop: () => {},
      },
    });

    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(written).toEqual([]);
    expect(JSON.stringify(turnEnd())).toContain(
      JSON.stringify({ status: "failed", messageIds: [] }),
    );
  });

  it("reports a broken reply whose message may have been created as unknown, so its caller does not send it again", async () => {
    const { turnEnd } = run(turnEvents(...answer), {
      streamReply: true,
      replies: {
        accept: () => {
          throw new Error("split failed");
        },
        settle: async () => ({
          status: "unknown",
          parts: [{ block: 0, text: "hi there", state: "unknown" }],
        }),
        stop: () => {},
      },
    });

    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(JSON.stringify(turnEnd())).toContain(
      JSON.stringify({ status: "unknown", messageIds: [] }),
    );
  });

  it("still ends the turn when the reply cannot settle, and reports the reply as unknown", async () => {
    const { turnEnd } = run(turnEvents(...answer), {
      streamReply: true,
      replies: {
        accept: () => {},
        settle: async () => {
          throw new Error("record failed");
        },
        stop: () => {},
      },
    });

    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(JSON.stringify(turnEnd())).toContain(
      JSON.stringify({ status: "unknown", messageIds: [] }),
    );
  });

  it("opens the reply in the conversation its caller records the run in", async () => {
    const { turnEnd, targets } = run(turnEvents(...answer), {
      streamReply: true,
      replies: {
        accept: () => {},
        settle: async () => ({ status: "delivered", parts: [] }),
        stop: () => {},
      },
    });

    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(targets).toEqual([
      expect.objectContaining({ channel: "telegram", romeSessionId: "conversation-1" }),
    ]);
  });

  it("stops writing the reply before it interrupts the provider", async () => {
    let more!: () => void;
    const gate = new Promise<void>((resolve) => (more = resolve));
    const events = (async function* (): AsyncIterable<StreamAgentEvent> {
      yield turnStart;
      yield { type: "text_delta", content: "Hello", blockId: "a" };
      await gate;
      yield { type: "text_delta", content: " world", blockId: "a" };
      yield { type: "turn_end", turnId: "turn-1", status: "interrupted", durationMs: 1 };
    })();
    const interrupt = rs.fn(async () => undefined);
    const { written, edits, turnEnd, turns } = run(events, { streamReply: true, interrupt });
    const ref = { connectionId: "c", chatId: "chat-1" as ChatId };

    await rs.waitFor(() => expect(written).toEqual([["chat-1", "Hello", "msg-1"]]));
    await turns.getActiveByConversation(ref)?.interrupt?.("chat-stop");
    expect(interrupt).toHaveBeenCalledWith("chat-stop");

    // The provider winds down and still emits text. None of it is written.
    more();
    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(written).toHaveLength(1);
    expect(edits).toEqual([]);
    expect(JSON.stringify(turnEnd())).toContain('"status":"stopped"');
  });

  it("stops writing the reply before it interrupts the provider when the worker disconnects", async () => {
    let more!: () => void;
    const gate = new Promise<void>((resolve) => (more = resolve));
    let end!: () => void;
    const ended = new Promise<void>((resolve) => (end = resolve));
    const events = (async function* (): AsyncIterable<StreamAgentEvent> {
      yield turnStart;
      yield { type: "text_delta", content: "Hello", blockId: "a" };
      await gate;
      yield { type: "text_delta", content: " world", blockId: "a" };
      await ended;
      yield { type: "turn_end", turnId: "turn-1", status: "interrupted", durationMs: 1 };
    })();
    const interrupt = rs.fn(async () => undefined);
    const { written, edits, turns, workerGone } = run(events, { streamReply: true, interrupt });

    await rs.waitFor(() => expect(written).toEqual([["chat-1", "Hello", "msg-1"]]));
    workerGone();
    await rs.waitFor(() => expect(interrupt).toHaveBeenCalledWith("action worker disconnected"));

    // The provider winds down and still emits text, with time for the reply
    // to write it. None of it is written. No worker is left to hear turn_end,
    // so the turn's end in the registry marks the reply settled.
    more();
    await new Promise((resolve) => setTimeout(resolve, 50));
    end();
    await rs.waitFor(() => expect(turns.get("turn-1")?.finished).toBe(true));
    expect(written).toHaveLength(1);
    expect(edits).toEqual([]);
  });

  it("drops the reply's queued writes when the worker disconnects after the run ended", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const created: string[] = [];
    const transport: DeliveryTransport = {
      capabilities: { maxPartLength: 100, edit: true, budget },
      codec: plainText,
      async create(conversation, text) {
        created.push(text);
        if (created.length === 1) await held;
        return { messageId: `m${created.length}`, chatId: conversation };
      },
      async edit() {},
    };
    const interrupt = rs.fn(async () => undefined);
    const { turns, workerGone } = run(
      turnEvents({ type: "text", content: "Looking." }, ...answer),
      { streamReply: true, interrupt, transport },
    );

    // The run has ended, and the reply's first write is still running.
    await rs.waitFor(() => expect(created).toEqual(["Looking."]));
    workerGone();
    await rs.waitFor(() => expect(interrupt).toHaveBeenCalledWith("action worker disconnected"));
    release();

    await rs.waitFor(() => expect(turns.get("turn-1")?.finished).toBe(true));
    expect(created).toEqual(["Looking."]);
  });

  it("writes nothing when the worker disconnects while the reply opens, and records the answer as usual", async () => {
    const { repo, answers, close } = await recorded();
    try {
      let read!: (on: boolean) => void;
      const setting = new Promise<boolean>((resolve) => (read = resolve));
      const interrupt = rs.fn(async () => undefined);
      const { written, turns, workerGone } = run(turnEvents(...answer), {
        streamReply: true,
        on: setting,
        interrupt,
        repo,
      });

      workerGone();
      await rs.waitFor(() => expect(interrupt).toHaveBeenCalledWith("action worker disconnected"));
      read(true);

      await rs.waitFor(() => expect(turns.get("turn-1")?.finished).toBe(true));
      expect(written).toEqual([]);
      expect(await answers()).toEqual([JSON.stringify([{ type: "text", content: "hi there" }])]);
    } finally {
      close();
    }
  });

  /** A repository holding the conversation the run is recorded in. */
  async function recorded() {
    const testDb = createTestDb();
    const repo = new WebChatRepository(testDb.db);
    await repo.ensureRomeSession({
      id: "conversation-1",
      type: "channel",
      name: "telegram:chat-1",
      agentName: null,
    });
    const answers = async () =>
      (await repo.getMessages("conversation-1"))
        .filter((message) => message.role === "assistant")
        .map((message) => message.content);
    return { repo, answers, close: () => testDb.close() };
  }

  it("records a streamed reply as the turn's one answer, under the message a quote of the answer names", async () => {
    const { repo, answers, close } = await recorded();
    try {
      const { written, turnEnd } = run(
        turnEvents({ type: "text", content: "Looking." }, ...answer),
        { streamReply: true, repo },
      );

      await rs.waitFor(() => expect(turnEnd()).toBeDefined());
      expect(written.map(([, text]) => text)).toEqual(["Looking.", "hi there"]);
      const shown = JSON.stringify([{ type: "text", content: "Looking.\n\nhi there" }]);
      expect(await answers()).toEqual([shown]);
      const { repliedTo } = await repo.loadConversationContext("conversation-1", "m2");
      expect(repliedTo?.content).toBe(shown);
    } finally {
      close();
    }
  });

  it("records only what a reply that failed partway showed", async () => {
    const { repo, answers, close } = await recorded();
    try {
      const transport: DeliveryTransport = {
        capabilities: { maxPartLength: 100, edit: true, budget },
        codec: plainText,
        async create(conversation, text) {
          if (text !== "Looking.") throw new DeliveryFailure("rejected", "refused");
          return { messageId: "m1", chatId: conversation };
        },
        async edit() {},
      };
      const { turnEnd } = run(turnEvents({ type: "text", content: "Looking." }, ...answer), {
        streamReply: true,
        repo,
        transport,
      });

      await rs.waitFor(() => expect(turnEnd()).toBeDefined());
      expect(JSON.stringify(turnEnd())).toContain(
        JSON.stringify({ status: "partial", messageIds: ["m1"] }),
      );
      expect(await answers()).toEqual([JSON.stringify([{ type: "text", content: "Looking." }])]);
    } finally {
      close();
    }
  });

  it("records the answer of a reply whose create may have landed, which its caller does not send", async () => {
    const { repo, answers, close } = await recorded();
    try {
      const transport: DeliveryTransport = {
        capabilities: { maxPartLength: 100, edit: true, budget },
        codec: plainText,
        async create() {
          throw new DeliveryFailure("unknown", "no answer");
        },
        async edit() {},
      };
      const { turnEnd } = run(turnEvents(...answer), { streamReply: true, repo, transport });

      await rs.waitFor(() => expect(turnEnd()).toBeDefined());
      expect(JSON.stringify(turnEnd())).toContain(
        JSON.stringify({ status: "unknown", messageIds: [] }),
      );
      expect(await answers()).toEqual([JSON.stringify([{ type: "text", content: "hi there" }])]);
    } finally {
      close();
    }
  });

  it("records a streamed reply in the conversation its turn is recorded in, when the caller names none", async () => {
    const { repo, answers, close } = await recorded();
    try {
      const { turnEnd } = run(turnEvents(...answer), { streamReply: true, repo, named: false });

      await rs.waitFor(() => expect(turnEnd()).toBeDefined());
      expect(await answers()).toEqual([JSON.stringify([{ type: "text", content: "hi there" }])]);
      expect(await repo.getMessages("channel:telegram:chat-1")).toEqual([]);
    } finally {
      close();
    }
  });
});
