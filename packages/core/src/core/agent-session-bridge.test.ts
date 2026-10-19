import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, StreamAgentEvent } from "@rome-os/app-runtime";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import type {
  AgentSession,
  AgentSessionInit,
  AgentSessionManager,
  AgentTurnHandle,
} from "./agent-session.js";
import { AgentSessionBridge, resolveAgentAppDataDir } from "./agent-session-bridge.js";
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
    new AgentSessionBridge(manager, { turnStreams: turns }).attach(
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
      new AgentSessionBridge(manager, { webchatRepo: repo }).attach(
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

  function setup(
    callerWorkingDirs: Record<string, string> = {},
    appDataDirForAgent?: (profileDir: string, agentName: string) => string | undefined,
  ) {
    const profileDir = realpathSync(mkdtempSync(join(tmpdir(), "rome-bridge-profile-")));
    tempDirs.push(profileDir);
    const projectsRoot = join(profileDir, "projects");
    mkdirSync(join(projectsRoot, "landingpage"), { recursive: true });
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
    new AgentSessionBridge(manager, {
      projectsRoot,
      ...(appDataDirForAgent
        ? { appDataDirForAgent: (agentName: string) => appDataDirForAgent(profileDir, agentName) }
        : {}),
    }).attach(
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
    return { profileDir, projectsRoot, acquired, runTurn };
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

  describe("app data directory", () => {
    const appDataDirs = (profileDir: string, agentName: string) =>
      ({
        "notes-app:planner": join(profileDir, "apps", "data", "notes-app"),
        "other-app:writer": join(profileDir, "apps", "data", "other-app"),
      })[agentName];
    const plannerKey = { agentName: "notes-app:planner", channelThreadKey: "notes-app:1" };

    function setupAppData() {
      const env = setup({}, appDataDirs);
      const dataDir = join(env.profileDir, "apps", "data", "notes-app");
      const planDir = join(dataDir, "plans", "plan-1");
      mkdirSync(planDir, { recursive: true });
      mkdirSync(join(env.profileDir, "apps", "data", "other-app", "work"), { recursive: true });
      return { ...env, dataDir, planDir };
    }

    it("opens an app agent's run in a folder inside its own app data directory", async () => {
      const { acquired, runTurn, dataDir, planDir } = setupAppData();

      const inside = await runTurn({ key: plannerKey, init: { workingDir: planDir } });
      const dataDirItself = await runTurn({ key: plannerKey, init: { workingDir: dataDir } });

      expect(inside.error).toBeUndefined();
      expect(dataDirItself.error).toBeUndefined();
      expect(acquired.map((init) => init.workingDir)).toEqual([planDir, dataDir]);
    });

    it("still opens an app agent's run in a project", async () => {
      const { projectsRoot, acquired, runTurn } = setupAppData();

      const result = await runTurn({ key: plannerKey, init: { workingDir: "landingpage" } });

      expect(result.error).toBeUndefined();
      expect(acquired.map((init) => init.workingDir)).toEqual([join(projectsRoot, "landingpage")]);
    });

    it("refuses an app data folder for an agent with no app data directory", async () => {
      const { acquired, runTurn, planDir } = setupAppData();

      const result = await runTurn({
        key: { agentName: "core:main", channelThreadKey: "main:1" },
        init: { workingDir: planDir },
      });

      expect(result.error).toContain("is not inside the projects root");
      expect(acquired).toEqual([]);
    });

    it("refuses another app's data directory and the shared apps data parent", async () => {
      const { profileDir, acquired, runTurn, dataDir } = setupAppData();
      const otherAppWork = join(profileDir, "apps", "data", "other-app", "work");

      const otherApp = await runTurn({ key: plannerKey, init: { workingDir: otherAppWork } });
      const parent = await runTurn({
        key: plannerKey,
        init: { workingDir: join(profileDir, "apps", "data") },
      });

      for (const result of [otherApp, parent]) {
        expect(result.error).toContain("is not inside the projects root");
        expect(result.error).toContain(`or the app data directory of agent "notes-app:planner"`);
        expect(result.error).toContain(dataDir);
      }
      expect(acquired).toEqual([]);
    });

    it("refuses a symlink in the app data directory that points out of it", async () => {
      const { acquired, runTurn, dataDir } = setupAppData();
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "rome-bridge-outside-")));
      tempDirs.push(outside);
      symlinkSync(outside, join(dataDir, "escape"));

      const result = await runTurn({
        key: plannerKey,
        init: { workingDir: join(dataDir, "escape") },
      });

      expect(result.error).toContain("is not inside the projects root");
      expect(acquired).toEqual([]);
    });

    it("resolves a relative path only against the projects root", async () => {
      const { acquired, runTurn } = setupAppData();

      const result = await runTurn({ key: plannerKey, init: { workingDir: "plans/plan-1" } });

      expect(result.error).toContain("does not exist");
      expect(acquired).toEqual([]);
    });
  });
});

describe("resolveAgentAppDataDir", () => {
  const dataDirFor = (appId: string) => `/profile/apps/data/${appId}`;
  const loader = (canonical: Record<string, string>) => ({
    getCanonicalName(name: string): string {
      const resolved = canonical[name];
      if (!resolved) throw new Error(`Agent "${name}" not found`);
      return resolved;
    },
  });

  it("returns the owning app's data directory for an app agent, by canonical or legacy name", () => {
    const agents = loader({
      "notes-app:planner": "notes-app:planner",
      planner: "notes-app:planner",
    });

    expect(resolveAgentAppDataDir(agents, "notes-app:planner", dataDirFor)).toBe(
      "/profile/apps/data/notes-app",
    );
    expect(resolveAgentAppDataDir(agents, "planner", dataDirFor)).toBe(
      "/profile/apps/data/notes-app",
    );
  });

  it("returns undefined for a core agent and for an agent that does not resolve", () => {
    const agents = loader({ main: "core:main", "core:main": "core:main" });

    expect(resolveAgentAppDataDir(agents, "main", dataDirFor)).toBeUndefined();
    expect(resolveAgentAppDataDir(agents, "core:main", dataDirFor)).toBeUndefined();
    expect(resolveAgentAppDataDir(agents, "ghost-app:planner", dataDirFor)).toBeUndefined();
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
    new AgentSessionBridge(manager, {
      webchatRepo: options.webchatRepo,
      turnStreams: turns,
    }).attach(
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
