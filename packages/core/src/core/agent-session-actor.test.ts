import { expect, it, rs } from "@rstest/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessions,
  createModelResolver,
  romeSessionTracing,
  type Session,
  type SessionRepository,
  type Agent,
  type AgentCatalog,
  type TurnFacts,
  type AgentSession,
  type TurnActor,
  type ModelProvider,
  type ModelSessionEvent,
  type SubmitOptions,
  type AgentComputerUse,
  type ComputerUseGrant,
} from "../agent/index.js";
import { createSessionFromRun } from "./agent-runner.js";
import { bothAvailable, fakeAccounts } from "../test/kit/model-accounts.js";

import { buildConciergeTools } from "../concierge/tools.js";
import type { ConciergeService } from "../concierge/service.js";
import { romeToolPorts } from "./rome-tool-ports.js";
import type { SessionToolContext } from "./session-tools.js";
import {
  claimTaskInputActor,
  taskInputActor,
  refreshTaskInputActor,
  admitTaskInput,
} from "../webchat/task-input-actor.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withRunningSession(
  run: (value: {
    session: AgentSession;
    facts: TurnFacts;
    acknowledge(): void;
    finishFirst(): void;
    firstEnded(): Promise<void>;
    finishSecond(): void;
    nextStarted(): Promise<void>;
    openSession(): Promise<AgentSession>;
  }) => Promise<void>,
  initialActor: TurnActor = { kind: "visitor", accountId: "synthetic-visitor" },
  initialOptions: SubmitOptions = {},
  test: {
    computerUse?: AgentComputerUse;
    initialError?: boolean;
    deferConsumeSecond?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "rome-task-actor-stop-"));
  const rows = new Map<string, Session>();
  const repository: SessionRepository = {
    session: async (id) => rows.get(id) ?? null,
    current: async () => [...rows.values()][0] ?? null,
    predecessorOf: async () => null,
    add: async (row) => {
      rows.set(row.id, row);
      row.markSaved();
    },
    save: async (row) => {
      row.markSaved();
    },
    replace: async () => {
      throw new Error("unexpected replacement");
    },
    deprecatedCheckpoint: async () => null,
  };
  const agent: Agent = {
    name: "core:concierge",
    localName: "concierge",
    ownerId: "core",
    ownerType: "core",
    definition: {
      description: "synthetic",
      tier: "medium",
      providerId: "anthropic",
      reasoningEffort: "high",
      systemPromptPrefix: "Synthetic test",
      tools: [],
      actions: [],
      permissionMode: "default",
    },
  };
  const loader: AgentCatalog = { find: () => agent, list: () => [agent] };
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let facts: TurnFacts | undefined;
  let running = false;
  let runs = 0;
  let currentInputId: string | undefined;
  const turnEnds = Array.from({ length: 4 }, () => gate());
  const provider: ModelProvider = {
    id: "anthropic",
    builtinTools: new Set(),
    openSession: async (params) => {
      const base = createSessionFromRun(
        "anthropic",
        async function* () {
          const index = runs++;
          running = true;
          const inputId = currentInputId;
          if (inputId && !(index === 1 && test.deferConsumeSecond)) {
            yield { type: "input_status", inputId, state: "consumed" };
          }
          await Promise.race([ended, turnEnds[index].promise]);
          if (index === 0 && test.initialError) yield { type: "error", error: "synthetic failure" };
          else yield { type: "result", content: "done" };
        },
        params,
      );
      return {
        ...base,
        sendUserInput: async (input) => {
          currentInputId = input.inputId;
          return base.sendUserInput(input);
        },
        interrupt: async () => {
          await acknowledgement;
        },
      };
    },
  };
  const noop = () => {};
  const manager = createSessions(
    {
      agentLoader: loader,
      sessionRepository: repository,
      systemPrompts: { build: () => "Synthetic test", fingerprint: () => "synthetic" } as never,
      modelResolver: createModelResolver({
        providers: [provider],
        accounts: fakeAccounts(bothAvailable()),
      }),
      networkMcpServers: () => ({}),
      skillCatalog: { list: () => [], find: () => undefined },
      computerUse: test.computerUse,
      turnLifecycle: { started: noop, ended: noop, couldNotStart: noop } as never,
      readAnswerShape: () => {
        throw new Error("unexpected output schema");
      },
      sessionTracing: romeSessionTracing,
      turnUsage: new Proxy({}, { get: () => noop }) as never,
      folders: { defaultWorkingDir: directory, projectsFolder: directory },
      log: { info: noop, warn: noop, error: noop },
      actions: {
        list: () => [],
        permits: () => false,
        appOf: () => undefined,
        find: () => undefined,
        run: async () => ({ status: "ok" }),
      },
      defer: {
        schedule: async () => {
          throw new Error("unexpected defer");
        },
      },
      sessionTools: {
        forTurn: async (turn) => {
          facts = turn;
          return [];
        },
      },
    },
    { keepAliveAcrossTurns: true },
  );
  try {
    const openSession = () =>
      manager.open(
        { agentName: agent.name, channelThreadKey: "webchat:source" },
        {
          workingDir: directory,
          audience: "private",
          threadContext: { channel: "webchat", threadId: "source", threadType: "private" },
        },
      );
    const session = await openSession();
    const visitor = initialActor;
    const receipt = session.submit(
      {
        ...(initialOptions.computerUseGrant ? { inputId: "initial-computer-request" } : {}),
        prompt: "go",
      },
      { actor: visitor, priority: "next", ...initialOptions },
    );
    const firstTurn = await receipt.turn;
    await rs.waitFor(() => expect(running).toBe(true));
    if (initialOptions.computerUseGrant) {
      await rs.waitFor(() => expect(facts?.computerUseGrant?.()).toBeDefined());
    }
    await run({
      session,
      facts: facts!,
      acknowledge,
      finishFirst: () => turnEnds[0].resolve(),
      firstEnded: () => firstTurn.ended().then(() => {}),
      finishSecond: () => turnEnds[1].resolve(),
      nextStarted: () => rs.waitFor(() => expect(runs).toBeGreaterThan(1)),
      openSession,
    });
  } finally {
    acknowledge();
    end();
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}

const guardian = { kind: "guardian", userId: "synthetic-guardian" } as const;

it.each([
  "consumed",
  "failed",
])("scope and input status of a separate computer-use turn: %s", async (outcome) => {
  await withRunningSession(
    async ({ session, facts, finishFirst, finishSecond, nextStarted, acknowledge }) => {
      const grant = {
        deviceId: "synthetic-device",
        expiresAt: Date.now() + 30_000,
        allowPreemption: true as const,
      };
      const firstId = facts.turnId();
      expect(() =>
        session.submit(
          { inputId: "cannot-steer", prompt: "cannot steer" },
          { actor: guardian, computerUseGrant: grant },
        ),
      ).toThrow("requires a separate turn");
      expect(() =>
        session.submit(
          { inputId: "no-system", prompt: "no system grants" },
          { actor: guardian, priority: "after", initiatedBy: "system", computerUseGrant: grant },
        ),
      ).toThrow("requires an unexpired grant for a private guardian turn");
      expect(() =>
        session.submit(
          { prompt: "missing inputId" },
          { actor: guardian, priority: "after", computerUseGrant: grant },
        ),
      ).toThrow("requires an inputId");
      const statuses: string[] = [];
      const receipt = session.submit(
        { inputId: "computer-request", prompt: "separate input" },
        {
          actor: guardian,
          priority: "after",
          computerUseGrant: grant,
          onInputStatus: (event) => {
            expect(event.inputId).toBe("computer-request");
            expect(event.turnId).toBe(receipt.turnId);
            statuses.push(event.state);
          },
        },
      );
      expect(receipt.landed).toBe("queued");
      expect(receipt.turnId).not.toBe(firstId);
      expect(facts.turnId()).toBe(firstId);
      expect(facts.computerUseGrant?.()).toBeUndefined();
      await rs.waitFor(() => expect(statuses).toEqual(["queued"]));
      const originalDeviceId = grant.deviceId;
      grant.deviceId = "replacement-device";
      finishFirst();
      await nextStarted();
      expect(facts.turnId()).toBe(receipt.turnId);

      if (outcome === "consumed") {
        await rs.waitFor(() =>
          expect(facts.computerUseGrant?.()).toEqual({
            deviceId: originalDeviceId,
            expiresAt: grant.expiresAt,
            allowPreemption: true,
          }),
        );
      } else {
        // Before the provider confirms consumption, the grant is inactive and stop fails the input.
        expect(facts.computerUseGrant?.()).toBeUndefined();
        const stop = session.stop("user-stop");
        expect(facts.computerUseGrant?.()).toBeUndefined();
        acknowledge();
        await stop;
      }
      finishSecond();
      await (await receipt.turn).ended();
      expect(facts.computerUseGrant?.()).toBeUndefined();
      await rs.waitFor(() => expect(statuses).toEqual(["queued", outcome]));
    },
    guardian,
    {},
    { deferConsumeSecond: outcome === "failed" },
  );
});

it.each([
  false,
  true,
])("closes only the granted turn and does not transfer its grant (model error: %s)", async (initialError) => {
  const grant = { deviceId: "synthetic-device", expiresAt: Date.now() + 30_000 };
  const cancelTurn = rs.fn(async () => {});
  const cancelSession = rs.fn(async () => {});
  await withRunningSession(
    async ({ session, facts, finishFirst, finishSecond, nextStarted }) => {
      const grantedTurnId = facts.turnId();
      expect(facts.computerUseGrant?.()).toEqual(grant);
      const next = session.submit(
        { prompt: "ordinary follow-up" },
        { actor: guardian, priority: "after" },
      );
      expect(facts.computerUseGrant?.()).toEqual(grant);
      finishFirst();
      await nextStarted();
      expect(facts.turnId()).toBe(next.turnId);
      expect(facts.computerUseGrant?.()).toBeUndefined();
      finishSecond();
      await (await next.turn).ended();
      expect(cancelTurn).toHaveBeenCalledExactlyOnceWith(facts.sessionId, grantedTurnId);
      expect(cancelSession).not.toHaveBeenCalled();
    },
    guardian,
    { priority: "after", computerUseGrant: grant },
    {
      initialError,
      computerUse: {
        permits: () => false,
        run: async () => ({ content: [] }),
        cancelTurn,
        cancelSession,
      },
    },
  );
});

it("does not restore a grant after observing that it expired", async () => {
  const grant = { deviceId: "synthetic-device", expiresAt: Date.now() + 30_000 };
  await withRunningSession(
    async ({ facts }) => {
      expect(facts.computerUseGrant?.()).toEqual(grant);
      const clock = rs.spyOn(Date, "now").mockReturnValue(grant.expiresAt);
      try {
        expect(facts.computerUseGrant?.()).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
      expect(facts.computerUseGrant?.()).toBeUndefined();
    },
    guardian,
    { priority: "after", computerUseGrant: grant },
  );
});

it("releases the caller lease when a computer-use grant is rejected on submit", async () => {
  const inUse = (session: AgentSession) =>
    (session as AgentSession & { hasTurnInProgress: boolean }).hasTurnInProgress;

  await withRunningSession(async ({ session, finishFirst, firstEnded, openSession }) => {
    finishFirst();
    await firstEnded();
    await rs.waitFor(() => expect(inUse(session)).toBe(false));

    const validGrant = { deviceId: "synthetic-device", expiresAt: Date.now() + 30_000 };
    const expiredGrant = { deviceId: "synthetic-device", expiresAt: Date.now() - 1 };

    const wrongPriority = await openSession();
    expect(inUse(wrongPriority)).toBe(true);
    expect(() =>
      wrongPriority.submit(
        { inputId: "wrong-priority", prompt: "wrong priority" },
        { actor: guardian, priority: "next", computerUseGrant: validGrant },
      ),
    ).toThrow("requires a separate turn");
    expect(inUse(wrongPriority)).toBe(false);

    const expired = await openSession();
    expect(inUse(expired)).toBe(true);
    expect(() =>
      expired.submit(
        { inputId: "expired-grant", prompt: "expired grant" },
        { actor: guardian, priority: "after", computerUseGrant: expiredGrant },
      ),
    ).toThrow("requires an unexpired grant for a private guardian turn");
    expect(inUse(expired)).toBe(false);

    const nonPrivate = await openSession();
    expect(inUse(nonPrivate)).toBe(true);
    expect(() =>
      nonPrivate.submit(
        { inputId: "shared-audience", prompt: "shared audience" },
        {
          actor: guardian,
          priority: "after",
          parentAudience: "shared",
          computerUseGrant: validGrant,
        },
      ),
    ).toThrow("requires an unexpired grant for a private guardian turn");
    expect(inUse(nonPrivate)).toBe(false);

    const missingInputId = await openSession();
    expect(inUse(missingInputId)).toBe(true);
    expect(() =>
      missingInputId.submit(
        { prompt: "missing input id" },
        { actor: guardian, priority: "after", computerUseGrant: validGrant },
      ),
    ).toThrow("requires an inputId");
    expect(inUse(missingInputId)).toBe(false);
  }, guardian);
});

it("supersedes a running turn when supersedeRunning is set on an isolated computer-use turn and reports queued for follow-up next turns", async () => {
  await withRunningSession(async ({ session, finishFirst, firstEnded, nextStarted }) => {
    const grant = { deviceId: "synthetic-device", expiresAt: Date.now() + 30_000 };
    const cuReceipt = session.submit(
      { inputId: "cu-now", prompt: "take over now" },
      {
        actor: guardian,
        priority: "after",
        supersedeRunning: true,
        computerUseGrant: grant,
      },
    );
    expect(cuReceipt.landed).toBe("queued");
    finishFirst();
    await firstEnded();
    await nextStarted();

    const followUp = session.submit(
      { inputId: "follow-up-next", prompt: "after computer use" },
      { actor: guardian, priority: "next" },
    );
    expect(followUp.landed).toBe("queued");
  }, guardian);
});

it("drains a provider-retained steer B into its own ungranted turn before queued granted turn G opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rome-abg-retained-steer-"));
  const rows = new Map<string, Session>();
  const repository: SessionRepository = {
    session: async (id) => rows.get(id) ?? null,
    current: async () => [...rows.values()][0] ?? null,
    predecessorOf: async () => null,
    add: async (row) => {
      rows.set(row.id, row);
      row.markSaved();
    },
    save: async (row) => {
      row.markSaved();
    },
    replace: async () => {
      throw new Error("unexpected replacement");
    },
    deprecatedCheckpoint: async () => null,
  };
  const agent: Agent = {
    name: "core:concierge",
    localName: "concierge",
    ownerId: "core",
    ownerType: "core",
    definition: {
      description: "synthetic",
      tier: "medium",
      providerId: "anthropic",
      reasoningEffort: "high",
      systemPromptPrefix: "Synthetic test",
      tools: [],
      actions: ["*"],
      permissionMode: "default",
    },
  };
  const loader: AgentCatalog = { find: () => agent, list: () => [agent] };
  const grant: ComputerUseGrant = {
    deviceId: "synthetic-device",
    expiresAt: Date.now() + 30_000,
    allowPreemption: true,
  };

  let facts: TurnFacts | undefined;
  const finishA = gate();
  const steeredB = gate();
  const observed: Array<{
    nativeInputId: string;
    turnId: string | undefined;
    grant: ComputerUseGrant | undefined;
  }> = [];

  // Models Anthropic's native queue semantics: a steer accepted while turn A is
  // running sits in the provider's native queue; if A ends before consuming it,
  // the provider reports it `queued` (retained) and pauses until Rome opens the
  // next turn, answering native-queued inputs in FIFO order.
  const provider: ModelProvider = {
    id: "anthropic",
    builtinTools: new Set(),
    openSession: async () => {
      const outbox: ModelSessionEvent[] = [];
      let notifyOutbox: (() => void) | undefined;
      let closed = false;
      const pushEvent = (event: ModelSessionEvent) => {
        outbox.push(event);
        notifyOutbox?.();
        notifyOutbox = undefined;
      };
      const nativeQueue: string[] = [];
      const pendingSteers = new Set<string>();
      const deferredInputs = new Set<string>();
      let resumeTurn: (() => void) | undefined;

      const driver = (async () => {
        const waitOpen = () =>
          new Promise<void>((resolve) => {
            resumeTurn = resolve;
          });
        while (!closed) {
          if (nativeQueue.length === 0) {
            await waitOpen();
            if (closed) break;
          }
          const nativeInputId = nativeQueue.shift()!;
          pushEvent({ type: "input_status", inputId: nativeInputId, state: "consumed" });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          observed.push({
            nativeInputId,
            turnId: facts?.turnId(),
            grant: facts?.computerUseGrant?.(),
          });
          if (nativeInputId === "input-a") {
            await finishA.promise;
            for (const steeredId of pendingSteers) {
              deferredInputs.add(steeredId);
              pushEvent({ type: "input_status", inputId: steeredId, state: "queued" });
            }
            pendingSteers.clear();
          }
          pushEvent({
            type: "result",
            content: `reply:${nativeInputId}`,
            reasoningEffort: "medium",
          });
          if (deferredInputs.size > 0) {
            await waitOpen();
          }
        }
      })();

      return {
        providerId: "anthropic",
        model: "synthetic",
        events: (async function* () {
          while (!closed || outbox.length > 0) {
            if (outbox.length === 0) {
              await new Promise<void>((resolve) => {
                notifyOutbox = resolve;
              });
              continue;
            }
            yield outbox.shift()!;
          }
        })(),
        sendUserInput: async (input) => {
          const id = input.inputId ?? "anonymous";
          if (!deferredInputs.delete(id)) {
            nativeQueue.push(id);
          }
          resumeTurn?.();
          resumeTurn = undefined;
        },
        steerUserInput: async (input) => {
          if (!input.inputId) return "deferred";
          pendingSteers.add(input.inputId);
          nativeQueue.push(input.inputId);
          steeredB.resolve();
          return "accepted";
        },
        interrupt: async () => {},
        close: async () => {
          closed = true;
          resumeTurn?.();
          notifyOutbox?.();
          await driver;
        },
      };
    },
  };

  const noop = () => {};
  const manager = createSessions(
    {
      agentLoader: loader,
      sessionRepository: repository,
      systemPrompts: { build: () => "Synthetic test", fingerprint: () => "synthetic" } as never,
      modelResolver: createModelResolver({
        providers: [provider],
        accounts: fakeAccounts(bothAvailable()),
      }),
      networkMcpServers: () => ({}),
      skillCatalog: { list: () => [], find: () => undefined },
      turnLifecycle: { started: noop, ended: noop, couldNotStart: noop } as never,
      readAnswerShape: () => {
        throw new Error("unexpected output schema");
      },
      sessionTracing: romeSessionTracing,
      turnUsage: new Proxy({}, { get: () => noop }) as never,
      folders: { defaultWorkingDir: directory, projectsFolder: directory },
      log: { info: noop, warn: noop, error: noop },
      actions: {
        list: () => [],
        permits: () => false,
        appOf: () => undefined,
        find: () => undefined,
        run: async () => ({ status: "ok" }),
      },
      defer: {
        schedule: async () => {
          throw new Error("unexpected defer");
        },
      },
      sessionTools: {
        forTurn: async (turn) => {
          facts = turn;
          return [];
        },
      },
    },
    { keepAliveAcrossTurns: true },
  );

  try {
    const session = await manager.open(
      { agentName: agent.name, channelThreadKey: "webchat:abg" },
      {
        workingDir: directory,
        audience: "private",
        threadContext: { channel: "webchat", threadId: "abg", threadType: "private" },
      },
    );

    // 1. Start ordinary turn A.
    const receiptA = session.submit(
      { inputId: "input-a", prompt: "turn A" },
      { actor: guardian, priority: "next" },
    );
    await rs.waitFor(() => expect(observed).toHaveLength(1));

    // 2. Queue identified granted turn G behind A (same mutex priority 1 as normal identified turns).
    const receiptG = session.submit(
      { inputId: "input-g", prompt: "turn G" },
      { actor: guardian, priority: "after", computerUseGrant: grant },
    );

    // 3. Steer ordinary input B into A, then let A end with B retained by the provider.
    const receiptB = session.submit(
      { inputId: "input-b", prompt: "steer B" },
      { actor: guardian, priority: "next" },
    );
    await steeredB.promise;
    finishA.resolve();

    const turnA = await receiptA.turn;
    const turnB = await receiptB.turn;
    const turnG = await receiptG.turn;
    const [endA, endB, endG] = await Promise.all([turnA.ended(), turnB.ended(), turnG.ended()]);

    expect(endA).toMatchObject({ terminal: { type: "result", content: "reply:input-a" } });
    expect(endB).toMatchObject({ terminal: { type: "result", content: "reply:input-b" } });
    expect(endG).toMatchObject({ terminal: { type: "result", content: "reply:input-g" } });

    // B must drain in its own ungranted turn BEFORE G runs with G's grant.
    expect(observed).toEqual([
      { nativeInputId: "input-a", turnId: turnA.id, grant: undefined },
      { nativeInputId: "input-b", turnId: turnB.id, grant: undefined },
      { nativeInputId: "input-g", turnId: turnG.id, grant },
    ]);
  } finally {
    finishA.resolve();
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps a computer-use grant inactive during an SDK-started background turn until the granted input is consumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rome-sdk-bg-grant-"));
  const rows = new Map<string, Session>();
  const repository: SessionRepository = {
    session: async (id) => rows.get(id) ?? null,
    current: async () => [...rows.values()][0] ?? null,
    predecessorOf: async () => null,
    add: async (row) => {
      rows.set(row.id, row);
      row.markSaved();
    },
    save: async (row) => {
      rows.set(row.id, row);
      row.markSaved();
    },
    replace: async () => {
      throw new Error("unexpected replacement");
    },
    deprecatedCheckpoint: async () => null,
  };
  const agent: Agent = {
    name: "core:concierge",
    localName: "concierge",
    ownerId: "core",
    ownerType: "core",
    definition: {
      description: "synthetic",
      tier: "medium",
      providerId: "anthropic",
      reasoningEffort: "high",
      systemPromptPrefix: "Synthetic test",
      tools: [],
      actions: ["core:computer_use"],
      permissionMode: "default",
    },
  };
  const loader: AgentCatalog = { find: () => agent, list: () => [agent] };

  const grant: ComputerUseGrant = {
    deviceId: "synthetic-device",
    expiresAt: Date.now() + 30_000,
  };
  const runComputer = rs.fn(async (turn: TurnFacts) => ({
    content: [{ type: "text" as const, text: `grant:${turn.computerUseGrant?.()?.deviceId}` }],
  }));
  const computerUse: AgentComputerUse = {
    permits: (turn) => turn.computerUseGrant?.() !== undefined,
    run: runComputer,
  };

  let facts: TurnFacts | undefined;
  let tools:
    | {
        callTool: (
          group: "computer",
          name: string,
          input: Record<string, unknown>,
        ) => Promise<{
          content: Array<{ type: string; text?: string }>;
          isError?: boolean;
        }>;
      }
    | undefined;
  let pushEvent!: (event: ModelSessionEvent) => void;
  const sentG = gate();

  const provider: ModelProvider = {
    id: "anthropic",
    builtinTools: new Set(),
    openSession: async (params) => {
      tools = params.tools;
      const outbox: ModelSessionEvent[] = [];
      let notifyOutbox: (() => void) | undefined;
      let closed = false;
      pushEvent = (event) => {
        outbox.push(event);
        notifyOutbox?.();
        notifyOutbox = undefined;
      };
      return {
        providerId: "anthropic",
        model: "synthetic",
        events: (async function* () {
          while (!closed || outbox.length > 0) {
            if (outbox.length === 0) {
              await new Promise<void>((resolve) => {
                notifyOutbox = resolve;
              });
              continue;
            }
            yield outbox.shift()!;
          }
        })(),
        sendUserInput: async () => {
          sentG.resolve();
        },
        interrupt: async () => {},
        close: async () => {
          closed = true;
          notifyOutbox?.();
        },
      };
    },
  };

  const noop = () => {};
  const manager = createSessions(
    {
      agentLoader: loader,
      sessionRepository: repository,
      systemPrompts: { build: () => "Synthetic test", fingerprint: () => "synthetic" } as never,
      modelResolver: createModelResolver({
        providers: [provider],
        accounts: fakeAccounts(bothAvailable()),
      }),
      networkMcpServers: () => ({}),
      skillCatalog: { list: () => [], find: () => undefined },
      computerUse,
      turnLifecycle: { started: noop, ended: noop, couldNotStart: noop } as never,
      readAnswerShape: () => {
        throw new Error("unexpected output schema");
      },
      sessionTracing: romeSessionTracing,
      turnUsage: new Proxy({}, { get: () => noop }) as never,
      folders: { defaultWorkingDir: directory, projectsFolder: directory },
      log: { info: noop, warn: noop, error: noop },
      actions: {
        list: () => [],
        permits: () => false,
        appOf: () => undefined,
        find: () => undefined,
        run: async () => ({ status: "ok" }),
      },
      defer: {
        schedule: async () => {
          throw new Error("unexpected defer");
        },
      },
      sessionTools: {
        forTurn: async (turn) => {
          facts = turn;
          return [];
        },
      },
    },
    { keepAliveAcrossTurns: true },
  );

  try {
    const session = await manager.open(
      { agentName: agent.name, channelThreadKey: "webchat:sdk-bg" },
      {
        workingDir: directory,
        audience: "private",
        threadContext: { channel: "webchat", threadId: "sdk-bg", threadType: "private" },
      },
    );

    const receiptG = session.submit(
      { inputId: "input-g", prompt: "operate device" },
      { actor: guardian, priority: "after", computerUseGrant: grant },
    );

    // Wait until sendUserInput(G) has been invoked, while an SDK-started
    // background-task turn is still executing before G's replay arrives.
    await sentG.promise;
    expect(tools).toBeDefined();
    expect(facts?.computerUseGrant?.()).toBeUndefined();

    const bgCall = await tools!.callTool("computer", "computer_status", {});
    expect(bgCall.isError).toBe(true);
    expect(runComputer).not.toHaveBeenCalled();

    // Once the SDK replays G's own input, the grant activates for G's tool calls.
    pushEvent({ type: "input_status", inputId: "input-g", state: "consumed" });
    await rs.waitFor(() => expect(facts?.computerUseGrant?.()).toEqual(grant));

    const grantedCall = await tools!.callTool("computer", "computer_status", {});
    expect(grantedCall.isError).toBeFalsy();
    expect(runComputer).toHaveBeenCalledTimes(1);

    pushEvent({ type: "result", content: "done", reasoningEffort: "medium" });
    await (await receiptG.turn).ended();
    expect(facts?.computerUseGrant?.()).toBeUndefined();
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const reason of ["user-stop", "superseded"] as const) {
  it(`keeps visitor identity and revokes handoff liveness before ${reason} acknowledgement`, async () => {
    await withRunningSession(async ({ session, facts, acknowledge }) => {
      const visitor = facts.actor();
      expect(visitor?.kind).toBe("visitor");
      expect(facts.live?.()).toBe(true);
      const stopping = session.stop(reason);
      expect(facts.actor()).toEqual(visitor);
      expect(facts.live?.()).toBe(false);
      acknowledge();
      await stopping;
    });
  });
}

for (const kind of ["guardian", "visitor"] as const) {
  for (const change of [
    "same-person",
    "stop",
    "close",
    "actor",
    "audience",
    "chat",
    "group",
    "channel",
    "unattributed",
    "expiry",
  ] as const) {
    if (kind === "visitor" && change === "audience") continue;
    it(`${kind}: holds a pending task input through same-person now, with outcome ${change}`, async () => {
      await withRunningSession(
        async ({ session, facts, acknowledge, finishFirst, nextStarted }) => {
          let context!: SessionToolContext;
          const ports = romeToolPorts({
            actionRegistry: {} as never,
            actionEngine: {} as never,
            sessionTools: async (value) => {
              context = value;
              return [];
            },
          });
          await ports.sessionTools.forTurn(facts, true);
          const original = facts.actor();
          const sourceTurn = facts.turnId();
          const sender = context.captureTaskInput!();
          const body = { text: "synthetic pending start" };
          const paused = gate();
          const opened = gate();
          const owner = kind === "visitor" ? "visitor:synthetic-visitor" : "guardian";
          const rows = new Map([
            [
              "source",
              { id: "source", agentName: "core:concierge", ownerKey: owner, archivedAt: null },
            ],
            [
              "target",
              { id: "target", triggerKind: "concierge", ownerKey: owner, archivedAt: null },
            ],
          ]);
          const repo = { getSession: async (id: string) => rows.get(id) ?? null };
          let submitted = false;
          const pending = sender("target", body, async () => {
            const claim = claimTaskInputActor("target", body, {
              platform: "webchat",
              id: "core:concierge",
            })!;
            expect(claim.source.turnId).toBe(sourceTurn);
            expect(await taskInputActor(claim, repo as never, async () => "source")).toEqual(
              original,
            );
            opened.resolve();
            await paused.promise;
            expect(await refreshTaskInputActor(claim, repo as never, async () => "source")).toEqual(
              original,
            );
            admitTaskInput(claim, () => {
              submitted = true;
            });
            return {};
          });
          // Attach rejection before releasing the async open, so negative cases cannot be unhandled.
          const outcome = pending.then(
            () => true,
            () => false,
          );
          await opened.promise;
          session.submit({ prompt: "one more detail" }, { actor: original, priority: "now" });
          acknowledge();
          finishFirst();
          await nextStarted();
          expect(facts.turnId()).not.toBe(sourceTurn);
          if (change === "stop") await session.stop("user-stop");
          if (change === "close") await session.close("user");
          if (!["same-person", "stop", "close", "expiry"].includes(change)) {
            const thread = {
              channel: "webchat",
              threadId: "source",
              threadType: "private" as const,
            };
            const actor =
              change === "actor"
                ? { kind: "guardian", userId: "synthetic-other" }
                : change === "unattributed"
                  ? undefined
                  : original;
            session.submit(
              { prompt: "changed scope" },
              {
                actor,
                priority: "now",
                ...(change === "audience" ? { parentAudience: "shared" as const } : {}),
                threadContext: {
                  ...thread,
                  ...(change === "chat" ? { threadId: "other" } : {}),
                  ...(change === "group" ? { threadType: "group" as const } : {}),
                  ...(change === "channel" ? { channel: "discord" } : {}),
                },
              },
            );
            // Returning to the original person/scope must not resurrect a revoked lease.
            session.submit({ prompt: "back to original" }, { actor: original, priority: "now" });
          }
          const clock =
            change === "expiry"
              ? rs.spyOn(Date, "now").mockReturnValue(Date.now() + 30_001)
              : undefined;
          try {
            paused.resolve();
            expect(await outcome).toBe(change === "same-person");
            expect(submitted).toBe(change === "same-person");
          } finally {
            clock?.mockRestore();
          }
        },
        kind === "guardian"
          ? { kind: "guardian", userId: "synthetic-seat" }
          : { kind: "visitor", accountId: "synthetic-visitor" },
      );
    });
  }
}

for (const pauseAt of ["chat-creation", "cold-open"] as const) {
  it(`chat_start keeps its original guardian through a now follow-up during ${pauseAt}`, async () => {
    await withRunningSession(
      async ({ session, facts, acknowledge, finishFirst, nextStarted }) => {
        let context!: SessionToolContext;
        const ports = romeToolPorts({
          actionRegistry: {} as never,
          actionEngine: {} as never,
          sessionTools: async (value) => {
            context = value;
            return [];
          },
        });
        await ports.sessionTools.forTurn(facts, true);
        const originalActor = facts.actor();
        const originalTurn = facts.turnId();
        const setup = gate();
        const resume = gate();
        const rows = new Map([
          [
            "source",
            { id: "source", agentName: "core:concierge", ownerKey: "guardian", archivedAt: null },
          ],
          [
            "target",
            { id: "target", triggerKind: "concierge", ownerKey: "guardian", archivedAt: null },
          ],
        ]);
        const repo = {
          getSession: async (id: string) => rows.get(id) ?? null,
          getTurnChatMessages: async () => [],
          // The message the task points to, which the Concierge said earlier.
          getReplyTarget: async (_chat: string, id: string) =>
            id === "start" ? { id, role: "assistant" } : null,
          setSessionTrigger: async () => {},
          updateSessionName: async () => {},
          deleteSession: rs.fn(async () => {}),
        };
        let submitted = 0;
        const failed = rs.fn(async () => {});
        const service = {
          ownerOfChat: async () => "guardian",
          promptsHandedOn: () => [],
          failedStart: () => null,
          noteFailedStart: rs.fn(),
          deps: {
            webchatRepo: repo,
            messages: {},
            tasks: {
              repo: {
                getWithChat: async () => ({
                  owner: "guardian",
                  row: { id: "task" },
                  conciergeChat: { id: "source" },
                }),
                create: async () => ({ id: "target" }),
                markStartFailed: failed,
              },
            },
          },
          dashboard: {
            chats: {
              startChat: async () => {
                if (pauseAt === "chat-creation") {
                  setup.resolve();
                  await resume.promise;
                }
                return "target";
              },
            },
            send: async (
              _place: unknown,
              body: import("../chats/send.js").Body,
              as: import("@rome-os/app-runtime").Account,
            ) => {
              const claim = claimTaskInputActor("target", body, as)!;
              expect(claim.source.turnId).toBe(originalTurn);
              expect(await taskInputActor(claim, repo as never, async () => "source")).toEqual(
                originalActor,
              );
              if (pauseAt === "cold-open") {
                setup.resolve();
                await resume.promise;
              }
              expect(
                await refreshTaskInputActor(claim, repo as never, async () => "source"),
              ).toEqual(originalActor);
              admitTaskInput(claim, () => {
                submitted++;
              });
              expect(() =>
                admitTaskInput(claim, () => {
                  submitted++;
                }),
              ).toThrow();
              return { ok: true };
            },
          },
        } as unknown as ConciergeService;
        const tools = await buildConciergeTools(service, context);
        const pending = tools
          .find((tool) => tool.name === "chat_start")!
          .handler({
            messageId: "start",
            title: "Synthetic",
            brief: "Synthetic public metadata only",
          });
        await setup.promise;
        session.submit({ prompt: "one extra detail" }, { actor: originalActor, priority: "now" });
        acknowledge();
        finishFirst();
        await nextStarted();
        expect(facts.turnId()).not.toBe(originalTurn);
        resume.resolve();
        expect((await pending).isError).toBeFalsy();
        expect(submitted).toBe(1);
        expect(failed).not.toHaveBeenCalled();
        expect(repo.deleteSession).not.toHaveBeenCalled();
      },
      { kind: "guardian", userId: "synthetic-seat" },
    );
  });
}

for (const stopInGap of [false, true]) {
  it(`keeps the same-person lease between turns unless Stop arrives in the gap (${stopInGap})`, async () => {
    await withRunningSession(async ({ session, facts, acknowledge, finishFirst, nextStarted }) => {
      const current = facts.captureTaskInputLiveness!();
      const actor = facts.actor();
      const gap = gate();
      let stopped: Promise<void> | undefined;
      const unsubscribe = session.onStatusChange((event) => {
        if (event.status !== "idle") return;
        expect(facts.live?.()).toBe(false);
        expect(current()).toBe(true);
        if (stopInGap) stopped = session.stop("user-stop");
        expect(current()).toBe(!stopInGap);
        gap.resolve();
      });
      try {
        session.submit({ prompt: "same person" }, { actor, priority: "now" });
        acknowledge();
        finishFirst();
        await gap.promise;
        await stopped;
        await nextStarted();
        expect(current()).toBe(!stopInGap);
      } finally {
        unsubscribe();
      }
    });
  });
}

it("does not preserve a normally completed source without a same-person now input", async () => {
  await withRunningSession(async ({ session, facts, finishFirst }) => {
    const current = facts.captureTaskInputLiveness!();
    expect(current()).toBe(true);
    finishFirst();
    await rs.waitFor(() => expect(session.status).toBe("idle"));
    expect(current()).toBe(false);
  });
});
