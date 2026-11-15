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
  type ModelProvider,
} from "../agent/index.js";
import { createSessionFromRun } from "./agent-runner.js";
import { bothAvailable, fakeAccounts } from "../test/kit/model-accounts.js";

for (const reason of ["user-stop", "superseded"] as const) {
  it(`keeps visitor identity and revokes handoff liveness before ${reason} acknowledgement`, async () => {
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
    const provider: ModelProvider = {
      id: "anthropic",
      builtinTools: new Set(),
      openSession: async (params) => ({
        ...createSessionFromRun(
          "anthropic",
          async function* () {
            running = true;
            await ended;
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
          threadContext: { channel: "webchat", threadId: "source", threadType: "private" },
        },
      );
      const visitor = { kind: "visitor", accountId: "synthetic-visitor" };
      const receipt = session.submit({ prompt: "go" }, { actor: visitor, priority: "after" });
      const handle = await receipt.turn;
      const drain = (async () => {
        for await (const _event of handle.events()) {
        }
      })();
      await rs.waitFor(() => expect(running).toBe(true));
      expect(facts?.actor()).toEqual(visitor);
      expect(facts?.live?.()).toBe(true);
      const stopping = session.stop(reason);
      expect(facts?.actor()).toEqual(visitor);
      expect(facts?.live?.()).toBe(false);
      acknowledge();
      end();
      await stopping;
      await drain;
      session.release();
    } finally {
      acknowledge();
      end();
      await manager.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
