import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, StreamAgentMessage } from "@rome-os/app-runtime";
import { createAgentTurnStreamRegistry } from "./agent-turn-stream-registry.js";
import type {
  AgentSession,
  AgentSessionInit,
  AgentSessionManager,
  AgentTurnHandle,
} from "./agent-session.js";
import { AgentSessionBridge } from "./agent-session-bridge.js";

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

describe("AgentSessionBridge working dir", () => {
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
          events: (async function* (): AsyncIterable<StreamAgentMessage> {})(),
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

  it("inherits the calling session's working dir when none is requested", async () => {
    const { acquired, runTurn } = setup({ "caller-session": "/profile/projects/site" });

    await runTurn({ actionContext: { sessionId: "caller-session", agentName: "main" } });
    await runTurn({ actionContext: { sessionId: "closed-session", agentName: "main" } });
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
      actionContext: { sessionId: "caller-session" },
    });

    expect(acquired.map((init) => init.workingDir)).toEqual([join(projectsRoot, "landingpage")]);
  });

  it("leaves an explicit resume to reopen where its transcript lives", async () => {
    const { acquired, runTurn } = setup({ "caller-session": "/profile/projects/site" });

    await runTurn({ sessionId: "summoned-1", actionContext: { sessionId: "caller-session" } });

    expect(acquired.map((init) => init.workingDir)).toEqual([undefined]);
  });
});
