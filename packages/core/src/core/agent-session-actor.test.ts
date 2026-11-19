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
    nextStarted(): Promise<void>;
  }) => Promise<void>,
  initialActor: TurnActor = { kind: "visitor", accountId: "synthetic-visitor" },
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
  const turnEnds = Array.from({ length: 4 }, () => gate());
  const provider: ModelProvider = {
    id: "anthropic",
    builtinTools: new Set(),
    openSession: async (params) => ({
      ...createSessionFromRun(
        "anthropic",
        async function* () {
          const index = runs++;
          running = true;
          await Promise.race([ended, turnEnds[index].promise]);
          yield { type: "result", content: "done" };
        },
        params,
      ),
      interrupt: async () => {
        await acknowledgement;
      },
    }),
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
      { agentName: agent.name, channelThreadKey: "webchat:source" },
      {
        workingDir: directory,
        audience: "private",
        threadContext: { channel: "webchat", threadId: "source", threadType: "private" },
      },
    );
    const visitor = initialActor;
    const receipt = session.submit({ prompt: "go" }, { actor: visitor, priority: "next" });
    await receipt.turn;
    await rs.waitFor(() => expect(running).toBe(true));
    await run({
      session,
      facts: facts!,
      acknowledge,
      finishFirst: () => turnEnds[0].resolve(),
      nextStarted: () => rs.waitFor(() => expect(runs).toBeGreaterThan(1)),
    });
  } finally {
    acknowledge();
    end();
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}

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
