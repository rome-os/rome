import type { RunLineDeps } from "../connections/speaker-messages.js";
import { testTurnHandle, submitStartingTurn } from "../test/turn-handle.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChatId, StreamAgentEvent } from "@rome-os/app-runtime";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import { createChatTurns } from "./chat-turns.js";
import type { AgentSession, SessionOpening, Sessions, AgentTurnHandle } from "../agent/index.js";
import type { ChatResetPolicy } from "./chat-reset-policy.js";
import type { SessionOpeningFor } from "./session-opening.js";
import { AgentSessionBridge } from "./agent-session-bridge.js";
import { canOpen } from "../webchat/privacy.js";
import { IpcRpc, createChildProcessTransport } from "../apps/actions/ipc.js";
import { WebChatRepository } from "../webchat/repository.js";
import { createTestDb } from "../test/db.js";
import { sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";

class FakeChild extends EventEmitter {
  connected = true;
  sent: unknown[] = [];

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
}

describe("AgentSessionBridge turn routing", () => {
  it("lists a started provider conversation's turn in its chat and as a live turn", async () => {
    let startTurn!: () => void;
    const start = new Promise<void>((resolve) => {
      startTurn = resolve;
    });
    let finishTurn!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
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
      submit: submitStartingTurn,
      startTurn: () => testTurnHandle({ turnId: "turn-1", events }) as unknown as AgentTurnHandle,
    } as unknown as AgentSession;
    const manager = {
      open: async () => session,
      find: () => session,
    } as unknown as Sessions;
    const turns = createAgentTurnStreamRegistry();
    const chatTurns = createChatTurns();
    const child = new FakeChild();
    new AgentSessionBridge(
      manager,
      undefined,
      undefined,
      turns,
      undefined,
      undefined,
      undefined,
      undefined,
      (chat, turn) => chatTurns.start(chat, turn),
    ).attach(
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
    expect(chatTurns.runningIn(ref)).toBeUndefined();

    startTurn();
    await rs.waitFor(() => expect(chatTurns.runningIn(ref)?.turnId).toBe("turn-1"));
    expect(chatTurns.runningIn(ref)?.initiatorId).toBe("user-1");

    expect(turns.get("turn-1")).toMatchObject({ sessionId: "session-1", finished: false });

    finishTurn();
    await rs.waitFor(() => expect(chatTurns.runningIn(ref)).toBeUndefined());
  });
});

describe("AgentSessionBridge conversation", () => {
  it("records a turn with no caller conversation in the one the session recorded", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      await repo.ensureRomeSession({
        id: "child-chat",
        type: "subagent",
        name: "researcher: Parent",
        agentName: "researcher",
      });
      // The chat that has the session is read from the session's stored row.
      const now = new Date();
      await testDb.db.insert(sessions).values({
        id: "session-1",
        agentName: "main",
        channelThreadKey: "discord:channel-1",
        chatId: "child-chat",
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      });
      type TurnRef = { romeSessionId?: string; romeSessionType?: string };
      const sent: TurnRef[] = [];
      const session = {
        key: { agentName: "main", channelThreadKey: "discord:channel-1" },
        sessionId: "session-1",
        submit: submitStartingTurn,
        startTurn: (_input: unknown, options: TurnRef) => {
          sent.push({ romeSessionId: options.romeSessionId });
          return testTurnHandle({
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
          }) as unknown as AgentTurnHandle;
        },
      } as unknown as AgentSession;
      const manager = {
        open: async () => session,
        resume: async () => session,
        find: () => session,
      } as unknown as Sessions;
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

      await rs.waitFor(() => expect(sent).toEqual([{ romeSessionId: "child-chat" }]));
      // The response names the chat's type the turn records under.
      await rs.waitFor(() =>
        expect(child.sent).toContainEqual(
          expect.objectContaining({
            type: "rpc_response",
            reqId: "request-1",
            result: expect.objectContaining({
              romeSession: { _romeSessionId: "child-chat", _type: "subagent" },
            }),
          }),
        ),
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

describe("AgentSessionBridge resuming a session by its id", () => {
  it("refuses a caller who may not open the session's chat, and lets its owner in", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      await repo.createSession(
        "concierge",
        "Concierge",
        undefined,
        undefined,
        undefined,
        undefined,
        "core:concierge",
      );
      await repo.createSession("plain", "Plain");
      const sent: unknown[] = [];
      const session = {
        key: { agentName: "core:concierge", channelThreadKey: "webchat:concierge" },
        sessionId: "guardian-runtime",
        submit: submitStartingTurn,
        startTurn: (input: unknown) => {
          sent.push(input);
          return testTurnHandle({
            turnId: `turn-${sent.length}`,
            events: (async function* (): AsyncIterable<StreamAgentEvent> {})(),
            interrupt: async () => undefined,
          }) as unknown as AgentTurnHandle;
        },
      } as unknown as AgentSession;
      const manager = {
        open: async () => session,
        resume: async () => session,
        find: () => session,
      } as unknown as Sessions;
      const child = new FakeChild();
      new AgentSessionBridge(manager, repo).attach(
        new IpcRpc(createChildProcessTransport(child as unknown as ChildProcess), "main"),
        child as unknown as ChildProcess,
      );
      // A summon from an ordinary chat names the guardian's Concierge runtime.
      const summon = (reqId: string, actor: Record<string, unknown>) =>
        child.emit("message", {
          type: "rpc_request",
          reqId,
          method: "agent.session.runTurn",
          callerActionName: "system:summon",
          callerActionContext: {
            actor,
            channelContext: { channel: "webchat", threadId: "plain" },
          },
          params: {
            key: session.key,
            sessionId: "guardian-runtime",
            input: { prompt: "what did they say?" },
          },
        });
      const responseTo = (reqId: string) =>
        child.sent.find(
          (m) =>
            (m as { reqId?: string }).reqId === reqId &&
            (m as { type?: string }).type === "rpc_response",
        ) as { error?: unknown } | undefined;

      summon("as-visitor", { kind: "visitor", accountId: "a", email: "a@example.com" });
      await rs.waitFor(() => expect(responseTo("as-visitor")).toBeDefined());
      expect(responseTo("as-visitor")?.error).toBeDefined();
      expect(sent).toEqual([]);

      summon("as-guardian", { kind: "guardian", userId: "seat", via: "cookie" });
      await rs.waitFor(() => expect(sent).toHaveLength(1));
    } finally {
      testDb.close();
    }
  });
});

describe("AgentSessionBridge chat link on resume", () => {
  it("never lets a worker move the chat that has a session it resumes", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      await repo.createSession(
        "private-chat",
        "Private",
        undefined,
        undefined,
        undefined,
        undefined,
        null,
        "webchat",
        null,
        { ownerKey: "guardian" },
      );
      await repo.createSession("worker-chat", "Worker");
      const now = new Date();
      await testDb.db.insert(sessions).values({
        id: "runtime-1",
        agentName: "main",
        channelThreadKey: "telegram:t1",
        chatId: "private-chat",
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      });
      const sent: unknown[] = [];
      const open = () =>
        ({
          key: { agentName: "main", channelThreadKey: "telegram:t1" },
          sessionId: "runtime-1",
          submit: submitStartingTurn,
          startTurn: (input: unknown) => {
            sent.push(input);
            return testTurnHandle({
              turnId: `turn-${sent.length}`,
              events: (async function* (): AsyncIterable<StreamAgentEvent> {})(),
              interrupt: async () => undefined,
            }) as unknown as AgentTurnHandle;
          },
        }) as unknown as AgentSession;
      // Each resume reopens the session, as a cold open would.
      const manager = {
        open: async () => open(),
        find: () => undefined,
      } as unknown as Sessions;
      const child = new FakeChild();
      new AgentSessionBridge(manager, repo).attach(
        new IpcRpc(createChildProcessTransport(child as unknown as ChildProcess), "main"),
        child as unknown as ChildProcess,
      );
      const resume = (reqId: string, actor: Record<string, unknown>, sessionId?: string) =>
        child.emit("message", {
          type: "rpc_request",
          reqId,
          method: "agent.session.runTurn",
          callerActionName: "system:summon",
          callerActionContext: {
            actor,
            channelContext: { channel: "webchat", threadId: "worker-chat" },
          },
          params: {
            key: { agentName: "main", channelThreadKey: "telegram:t1" },
            ...(sessionId ? { sessionId } : {}),
            input: { prompt: "hello" },
            init: { romeSessionId: "worker-chat" },
          },
        });
      const responseTo = (reqId: string) =>
        child.sent.find(
          (m) =>
            (m as { reqId?: string }).reqId === reqId &&
            (m as { type?: string }).type === "rpc_response",
        );
      const linked = async () =>
        (await testDb.db.select().from(sessions).where(eq(sessions.id, "runtime-1")))[0]?.chatId;

      resume("by-id", { kind: "visitor", accountId: "a", email: "a@example.com" }, "runtime-1");
      await rs.waitFor(() => expect(responseTo("by-id")).toBeDefined());
      resume("by-key", { kind: "visitor", accountId: "a", email: "a@example.com" });
      await rs.waitFor(() => expect(responseTo("by-key")).toBeDefined());

      expect(await linked()).toBe("private-chat");
    } finally {
      testDb.close();
    }
  });
});

describe("AgentSessionBridge fresh run started from a chat", () => {
  it("records a summon from a private task chat as that chat's owner's, private from the start", async () => {
    const testDb = createTestDb();
    try {
      const repo = new ChatsWebChatRepository(testDb.db);
      await repo.createSession(
        "guardian-task",
        "Task",
        undefined,
        undefined,
        undefined,
        undefined,
        null,
        "webchat",
        null,
        { ownerKey: "guardian" },
      );
      await repo.setSessionTrigger("guardian-task", { triggerKind: "concierge", triggerName: "T" });
      const session = {
        key: { agentName: "main", channelThreadKey: "summon:exec-1" },
        sessionId: "summon-runtime",
        submit: submitStartingTurn,
        startTurn: () =>
          testTurnHandle({
            turnId: "summon-turn",
            events: (async function* (): AsyncIterable<StreamAgentEvent> {
              yield {
                type: "turn_start",
                turnId: "summon-turn",
                sessionId: "summon-runtime",
                userPrompt: "look it up",
                agent: "main",
              };
              yield { type: "result", content: "Found it", agent: "main" };
            })(),
            interrupt: async () => undefined,
          }) as unknown as AgentTurnHandle,
      } as unknown as AgentSession;
      const manager = {
        open: async () => session,
        resume: async () => session,
        find: () => session,
      } as unknown as Sessions;
      const child = new FakeChild();
      new AgentSessionBridge(manager, repo).attach(
        new IpcRpc(createChildProcessTransport(child as unknown as ChildProcess), "main"),
        child as unknown as ChildProcess,
      );
      child.emit("message", {
        type: "rpc_request",
        reqId: "summon-1",
        method: "agent.session.runTurn",
        params: {
          key: session.key,
          input: { prompt: "look it up" },
          actionContext: {
            actionName: "system:summon",
            executionId: "exec-1",
            channelContext: { channel: "webchat", threadId: "guardian-task" },
          },
        },
      });
      const runId = "action:exec-1:main";
      await rs.waitFor(async () => expect(await repo.getSession(runId)).not.toBeNull());
      const run = await repo.getSession(runId);
      expect(run).toMatchObject({ ownerKey: "guardian", triggerKind: "concierge_fork" });
      expect(canOpen(run, "visitor:a")).toBe(false);
      expect(canOpen(run, "guardian")).toBe(true);
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

  function setup(
    callerWorkingDirs: Record<string, string> = {},
    resetPolicyOf?: ChatResetPolicy,
    openingFor?: SessionOpeningFor,
  ) {
    const projectsRoot = realpathSync(mkdtempSync(join(tmpdir(), "rome-bridge-projects-")));
    tempDirs.push(projectsRoot);
    mkdirSync(join(projectsRoot, "landingpage"));
    const acquired: SessionOpening[] = [];
    const session = {
      key: { agentName: "coder", channelThreadKey: "coder:1" },
      sessionId: "summoned-1",
      submit: submitStartingTurn,
      startTurn: () =>
        testTurnHandle({
          turnId: "turn-1",
          events: (async function* (): AsyncIterable<StreamAgentEvent> {})(),
          interrupt: async () => undefined,
        }) as unknown as AgentTurnHandle,
    } as unknown as AgentSession;
    const manager = {
      open: async (_key: unknown, init: SessionOpening) => {
        acquired.push(init);
        return session;
      },
      resume: async (_session: unknown, init: SessionOpening) => {
        acquired.push(init);
        return session;
      },
      find: () => undefined,
      findWorkingDirBySessionId: (id: string) => callerWorkingDirs[id],
    } as unknown as Sessions;
    const child = new FakeChild();
    new AgentSessionBridge(
      manager,
      undefined,
      undefined,
      undefined,
      projectsRoot,
      undefined,
      resetPolicyOf,
      openingFor,
    ).attach(
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

  it("opens with the reset policy of the message's chat, never one the worker sends", async () => {
    const policy = { mode: "idle", idleMinutes: 60 } as const;
    const { acquired, runTurn } = setup({}, async () => policy);
    const threadContext = { channel: "telegram", connectionId: "telegram-1", threadId: "t-1" };
    const forged = { mode: "idle", idleMinutes: 1 };

    await runTurn({ platformMessageId: "m-1", init: { threadContext, resetPolicy: forged } });
    await runTurn({ init: { threadContext, resetPolicy: forged } });

    expect(acquired.map((init) => init.resetPolicy)).toEqual([policy, undefined]);
  });

  it("opens with what it states for the session, never what the worker sends", async () => {
    const stated = {
      drawsCards: false,
      guardianFacing: true,
      toolEnv: { ROME_CHANNEL: "telegram" },
      spanAttributes: { "channel.name": "telegram" },
    };
    const { acquired, runTurn } = setup({}, undefined, () => stated);
    const forged = {
      drawsCards: true,
      guardianFacing: false,
      toolEnv: { ROME_CHANNEL: "discord" },
      spanAttributes: { "channel.name": "discord" },
    };

    await runTurn({ init: forged });

    expect(acquired[0]).toMatchObject(stated);
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
    const handle = testTurnHandle({ turnId, events, interrupt }) as unknown as AgentTurnHandle;
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
      submit: submitStartingTurn,
      startTurn: () => queue.shift()!,
    } as unknown as AgentSession;
    const manager = {
      open: async () => {
        await options.beforeAcquire?.();
        return session;
      },
      find: () => session,
    } as unknown as Sessions;
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
        params: {
          key: session.key,
          input: { prompt: "hello" },
          ...(options.romeSessionId ? { init: { romeSessionId: options.romeSessionId } } : {}),
          ...params,
        },
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
      recordSessionInChat: async () => null,
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

describe("AgentSessionBridge answer recording", () => {
  /** Runs one turn over the bridge. */
  function run(
    events: AsyncIterable<StreamAgentEvent>,
    {
      streamReply,
      repo,
      runLineDeps,
    }: {
      /** The deprecated ask to stream the reply, which the bridge ignores. */
      streamReply?: boolean;
      /** The repository the turn and its answer are recorded in. */
      repo?: WebChatRepository;
      /** Chats' messages, given once Chats records what the caller sends. */
      runLineDeps?: RunLineDeps;
    } = {},
  ) {
    const session = {
      key: { agentName: "main", channelThreadKey: "telegram:chat-1" },
      sessionId: "session-1",
      submit: submitStartingTurn,
      startTurn: () => testTurnHandle({ turnId: "turn-1", events }) as unknown as AgentTurnHandle,
    } as unknown as AgentSession;
    const manager = { open: async () => session } as unknown as Sessions;
    const turns = createAgentTurnStreamRegistry();
    const child = new FakeChild();
    new AgentSessionBridge(manager, repo, undefined, turns, undefined, runLineDeps).attach(
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
        ...(streamReply === undefined ? {} : { streamReply }),
        init: {
          romeSessionId: "conversation-1",
          threadContext: {
            channel: "telegram",
            connectionId: "c",
            threadId: "chat-1",
            channelUserId: "user-1",
          },
        },
      },
    });
    const turnEnd = () =>
      child.sent.find((message) => JSON.stringify(message).includes('"type":"turn_end"'));
    return { turnEnd };
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

  /** A repository holding the conversation the run is recorded in. */
  async function recorded() {
    const testDb = createTestDb();
    const repo = new ChatsWebChatRepository(testDb.db);
    await repo.ensureRomeSession({
      id: "conversation-1",
      type: "channel",
      name: "telegram:chat-1",
      agentName: null,
      sourceChannel: "telegram",
      sourceThreadId: "chat-1",
    });
    const answers = async () =>
      (await repo.getMessages("conversation-1"))
        .filter((message) => message.role === "assistant")
        .map((message) => message.content);
    return { repo, answers, close: () => testDb.close() };
  }

  for (const stands of [true, false]) {
    it(`records the answer ${stands ? "through its caller's send, in a chat" : "itself, outside any chat"}`, async () => {
      const { repo, answers, close } = await recorded();
      try {
        const { turnEnd } = run(turnEvents(...answer), {
          repo,
          runLineDeps: {
            lines: { recorded: async () => null, stands: () => stands },
            links: { prompt: () => {} },
          },
        });

        await rs.waitFor(() => expect(turnEnd()).toBeDefined());
        expect(await answers()).toEqual(
          stands ? [] : [JSON.stringify([{ type: "text", content: "hi there" }])],
        );
      } finally {
        close();
      }
    });
  }

  it("leaves the reply to its caller even when the run asks to stream it", async () => {
    const { turnEnd } = run(turnEvents(...answer), { streamReply: true });

    await rs.waitFor(() => expect(turnEnd()).toBeDefined());
    expect(JSON.stringify(turnEnd())).not.toContain("replyDelivery");
  });
});
