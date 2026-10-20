import type {
  AgentMessage,
  AppLogger,
  RomeAppContext,
  TurnMiddlewareContext,
  TurnMiddlewareHookDeps,
  TurnOutcome,
} from "@rome-os/app-runtime";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { WelcomeProgress } from "../../db/repositories/progress.js";
import { createHook } from "./index.js";

// The welcome's progress row, held in memory in place of the app database.
const progress: { row: WelcomeProgress } = {
  row: {
    node: "building",
    introRawInput: null,
    introSummary: null,
    ideas: [{ title: "Launch tracker", prompt: "Build me a launch tracker." }],
    ideasGeneratedAt: null,
    aiConnected: true,
    buildPrompt: "Build me a launch tracker.",
    buildSessionId: null,
    completedAt: null,
  },
};
const repositoryOpened = rs.fn();
rs.mock("../../db/repositories/progress.js", () => ({
  createProgressRepository: () => ({
    opened: repositoryOpened(),
    get: () => progress.row,
    patch: (patch: Partial<WelcomeProgress>) => {
      progress.row = { ...progress.row, ...patch };
      return progress.row;
    },
  }),
}));

const logger: AppLogger = {
  debug: rs.fn(),
  info: rs.fn(),
  warn: rs.fn(),
  error: rs.fn(),
};

function makeContext(
  agentName: string,
  emitted: AgentMessage[],
  prompt = "hello",
  channelThreadKey = "webchat:chat-1",
): TurnMiddlewareContext {
  return {
    input: { prompt },
    // The agent session's id differs from the chat's id in its key.
    session: { id: "agent-session-1", agentName, channelThreadKey },
    emit: (event) => emitted.push(event),
    meta: {},
  };
}

describe("welcome-to-rome turn middleware routing", () => {
  afterEach(() => {
    rs.useRealTimers();
    rs.clearAllMocks();
  });

  it("intercepts the app-owned canonical agent id", async () => {
    rs.useFakeTimers();
    const emitted: AgentMessage[] = [];
    const next = rs.fn(async () => {});
    const deps: TurnMiddlewareHookDeps = { appId: "welcome-to-rome", logger };
    const promise = createHook(deps).handle(
      makeContext("welcome-to-rome:welcome-to-rome", emitted),
      next,
    );

    await rs.runAllTimersAsync();
    await promise;

    expect(next).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({ type: "result" });
  });

  it("does not intercept the same local name owned by another app", async () => {
    const emitted: AgentMessage[] = [];
    const next = rs.fn(async () => {});
    const deps: TurnMiddlewareHookDeps = { appId: "welcome-to-rome", logger };

    await createHook(deps).handle(makeContext("other-app:welcome-to-rome", emitted), next);

    expect(next).toHaveBeenCalledOnce();
    expect(emitted).toEqual([]);
  });
});

describe("welcome-to-rome turn middleware after the onboarding build", () => {
  const finished: TurnOutcome = { status: "completed", suspended: false };
  const IDEA = "Build me a launch tracker.";

  afterEach(() => {
    rs.clearAllMocks();
  });

  function startBuilding() {
    progress.row = {
      ...progress.row,
      node: "building",
      buildPrompt: IDEA,
      buildSessionId: null,
      completedAt: null,
    };
  }

  function makeDeps(
    calls: string[],
    getSetting: (key: string) => Promise<unknown> = async () => null,
  ) {
    const runAction = rs.fn(async () => {
      calls.push("send_message");
      return { status: "ok" };
    });
    const appContext = {
      db: {},
      repositories: { settings: { get: getSetting, set: async () => {} } },
      runAction,
    } as unknown as RomeAppContext;
    const deps: TurnMiddlewareHookDeps = { appId: "welcome-to-rome", logger, appContext };
    return { deps, runAction };
  }

  it("posts the closing message as its own message once the build finishes", async () => {
    startBuilding();
    const calls: string[] = [];
    const { deps, runAction } = makeDeps(calls);
    const next = rs.fn(async () => {
      calls.push("model");
      return finished;
    });

    await createHook(deps).handle(makeContext("core:main", [], IDEA), next);

    expect(calls).toEqual(["model", "send_message"]);
    expect(runAction).toHaveBeenCalledWith("send_message", {
      channel: "webchat",
      threadId: "chat-1",
      text: expect.stringContaining("App Store"),
    });
    expect(progress.row.node).toBe("done");
  });

  it("waits through a parked build turn and posts after a later turn finishes", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    const hook = createHook(deps);

    // The agent asks a question card, then the guardian answers in the same chat.
    await hook.handle(
      makeContext("core:main", [], IDEA),
      rs.fn(async () => ({ status: "completed", suspended: true }) as TurnOutcome),
    );
    expect(runAction).not.toHaveBeenCalled();
    expect(progress.row.node).toBe("building");

    await hook.handle(
      makeContext("core:main", [], "Use a kanban board."),
      rs.fn(async () => finished),
    );
    expect(runAction).toHaveBeenCalledOnce();
    expect(progress.row.node).toBe("done");
  });

  it("keeps waiting on the build when the post fails, and posts after the next finished turn", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    runAction.mockResolvedValueOnce({ status: "error" });
    const hook = createHook(deps);

    await hook.handle(
      makeContext("core:main", [], IDEA),
      rs.fn(async () => finished),
    );
    expect(runAction).toHaveBeenCalledOnce();
    expect(progress.row.node).toBe("building");

    await hook.handle(
      makeContext("core:main", [], "Rename it."),
      rs.fn(async () => finished),
    );
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(progress.row.node).toBe("done");
  });

  it("lets the turn end while a slow post is still sending, and ends onboarding once it lands", async () => {
    rs.useFakeTimers();
    try {
      startBuilding();
      const { deps, runAction } = makeDeps([]);
      let land: (result: { status: string }) => void = () => {};
      runAction.mockImplementationOnce(
        () => new Promise<{ status: string }>((resolve) => (land = resolve)),
      );
      const hook = createHook(deps);

      let ended = false;
      const turn = hook
        .handle(
          makeContext("core:main", [], IDEA),
          rs.fn(async () => finished),
        )
        .then(() => (ended = true));
      await rs.advanceTimersByTimeAsync(10_000);
      await turn;
      expect(ended).toBe(true);
      expect(progress.row.node).toBe("building");

      // A later finished turn doesn't post a second message while one is sending.
      await hook.handle(
        makeContext("core:main", [], "Rename it."),
        rs.fn(async () => finished),
      );
      expect(runAction).toHaveBeenCalledOnce();

      land({ status: "ok" });
      await rs.advanceTimersByTimeAsync(0);
      expect(progress.row.node).toBe("done");
    } finally {
      rs.useRealTimers();
    }
  });

  it("adds nothing in the welcome chat when the guardian closes the handoff while the post sends", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    let land: (result: { status: string }) => void = () => {};
    runAction.mockImplementationOnce(
      () => new Promise<{ status: string }>((resolve) => (land = resolve)),
    );
    const hook = createHook(deps);
    const turn = hook.handle(
      makeContext("core:main", [], IDEA),
      rs.fn(async () => finished),
    );
    await rs.waitFor(() => expect(runAction).toHaveBeenCalledOnce());

    // The welcome's turn waits on the post rather than repeating it.
    const welcomeEmitted: AgentMessage[] = [];
    const welcomeTurn = hook.handle(
      makeContext(
        "welcome-to-rome:welcome-to-rome",
        welcomeEmitted,
        "The guardian dismissed the interaction without producing a result.",
        "webchat:welcome-chat",
      ),
      rs.fn(async () => {}),
    );
    expect(progress.row.node).toBe("building");

    land({ status: "ok" });
    await Promise.all([turn, welcomeTurn]);
    expect(welcomeEmitted).toEqual([]);
    expect(progress.row.node).toBe("done");
  });

  it("closes the welcome itself when the guardian closes the handoff and the post then fails", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    let land: (result: { status: string }) => void = () => {};
    runAction.mockImplementationOnce(
      () => new Promise<{ status: string }>((resolve) => (land = resolve)),
    );
    const hook = createHook(deps);
    const turn = hook.handle(
      makeContext("core:main", [], IDEA),
      rs.fn(async () => finished),
    );
    await rs.waitFor(() => expect(runAction).toHaveBeenCalledOnce());

    const welcomeEmitted: AgentMessage[] = [];
    const welcomeTurn = hook.handle(
      makeContext(
        "welcome-to-rome:welcome-to-rome",
        welcomeEmitted,
        "The guardian dismissed the interaction without producing a result.",
        "webchat:welcome-chat",
      ),
      rs.fn(async () => {}),
    );
    // The welcome's turn reaches the post before it fails.
    await new Promise((resolve) => setTimeout(resolve, 10));
    land({ status: "error" });
    await Promise.all([turn, welcomeTurn]);

    expect(welcomeEmitted).toContainEqual({
      type: "result",
      content: expect.stringContaining("all set"),
    });
    expect(progress.row.node).toBe("done");
  });

  it("keeps one closing message when installing the first app reloads the hook mid-build", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    let land: (result: { status: string }) => void = () => {};
    runAction.mockImplementationOnce(
      () => new Promise<{ status: string }>((resolve) => (land = resolve)),
    );
    const turn = createHook(deps).handle(
      makeContext("core:main", [], IDEA),
      rs.fn(async () => finished),
    );
    await rs.waitFor(() => expect(runAction).toHaveBeenCalledOnce());

    // Core builds a fresh hook on reload; the running build keeps the old one.
    const reloaded = createHook(deps);
    await reloaded.handle(
      makeContext("core:main", [], "Rename it."),
      rs.fn(async () => finished),
    );
    const welcomeEmitted: AgentMessage[] = [];
    const welcomeTurn = reloaded.handle(
      makeContext(
        "welcome-to-rome:welcome-to-rome",
        welcomeEmitted,
        "The guardian dismissed the interaction without producing a result.",
        "webchat:welcome-chat",
      ),
      rs.fn(async () => {}),
    );
    land({ status: "ok" });
    await Promise.all([turn, welcomeTurn]);

    expect(runAction).toHaveBeenCalledOnce();
    expect(welcomeEmitted).toEqual([]);
    expect(progress.row.node).toBe("done");
  });

  it("ends the welcome on a post that outlasts its ceiling, and never posts a second one", async () => {
    rs.useFakeTimers();
    try {
      startBuilding();
      const { deps, runAction } = makeDeps([]);
      let deliverLate: (sent: { status: string }) => void = () => {};
      runAction.mockImplementationOnce(
        () => new Promise<{ status: string }>((resolve) => (deliverLate = resolve)),
      );
      const hook = createHook(deps);

      const turn = hook.handle(
        makeContext("core:main", [], IDEA),
        rs.fn(async () => finished),
      );
      await rs.advanceTimersByTimeAsync(10_000);
      await turn;
      // Still within the ceiling: a finished turn doesn't post a second message.
      await hook.handle(
        makeContext("core:main", [], "Rename it."),
        rs.fn(async () => finished),
      );
      expect(runAction).toHaveBeenCalledOnce();
      expect(progress.row.node).toBe("building");

      // Past the ceiling the post may still land, so the welcome ends as
      // though it had and nothing posts again, even when it does land late.
      await rs.advanceTimersByTimeAsync(50_000);
      expect(progress.row.node).toBe("done");
      await hook.handle(
        makeContext("core:main", [], "Add a due date."),
        rs.fn(async () => finished),
      );
      deliverLate({ status: "ok" });
      await rs.advanceTimersByTimeAsync(0);
      expect(runAction).toHaveBeenCalledOnce();
      expect(progress.row.node).toBe("done");
    } finally {
      rs.useRealTimers();
    }
  });

  it("posts nothing when the guardian closes the handoff while the locale loads", async () => {
    startBuilding();
    let loadLocale: ((value: unknown) => void) | null = null;
    const { deps, runAction } = makeDeps([], (key) =>
      key === "guardianLanguage"
        ? new Promise((resolve) => (loadLocale = resolve))
        : Promise.resolve(null),
    );
    const turn = createHook(deps).handle(
      makeContext("core:main", [], IDEA),
      rs.fn(async () => finished),
    );
    await rs.waitFor(() => expect(loadLocale).not.toBeNull());

    // The welcome's `building` step closed onboarding with its own message.
    progress.row = { ...progress.row, node: "done", completedAt: "2026-10-15T00:00:00Z" };
    loadLocale?.("en");
    await turn;

    expect(runAction).not.toHaveBeenCalled();
  });

  it("posts nothing when the guardian closes the handoff while the build runs", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    const next = rs.fn(async () => {
      // The welcome's `building` step closed onboarding with its own message.
      progress.row = { ...progress.row, node: "done", completedAt: "2026-10-15T00:00:00Z" };
      return finished;
    });

    await createHook(deps).handle(makeContext("core:main", [], IDEA), next);

    expect(runAction).not.toHaveBeenCalled();
  });

  it("leaves a restarted welcome alone when the old build finishes", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    const next = rs.fn(async () => {
      progress.row = { ...progress.row, node: "await_names", buildSessionId: null };
      return finished;
    });

    await createHook(deps).handle(makeContext("core:main", [], IDEA), next);

    expect(runAction).not.toHaveBeenCalled();
    expect(progress.row.node).toBe("await_names");
  });

  it("leaves the main agent's other turns alone", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    const next = rs.fn(async () => finished);

    await createHook(deps).handle(makeContext("core:main", [], "Add a dark mode."), next);

    expect(next).toHaveBeenCalledOnce();
    expect(runAction).not.toHaveBeenCalled();
    expect(progress.row.node).toBe("building");
  });

  it("reads nothing for the main agent's turn outside a webchat chat", async () => {
    startBuilding();
    const { deps, runAction } = makeDeps([]);
    const next = rs.fn(async () => finished);

    await createHook(deps).handle(makeContext("core:main", [], IDEA, "telegram:42"), next);

    expect(next).toHaveBeenCalledOnce();
    expect(repositoryOpened).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
    expect(progress.row.node).toBe("building");
  });

  it("reads nothing for another agent's turn", async () => {
    startBuilding();
    const { deps } = makeDeps([]);
    const next = rs.fn(async () => finished);

    await createHook(deps).handle(makeContext("notes:writer", [], IDEA), next);

    expect(next).toHaveBeenCalledOnce();
    expect(repositoryOpened).not.toHaveBeenCalled();
  });
});
