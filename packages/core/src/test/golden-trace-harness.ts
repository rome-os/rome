import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tracer } from "@opentelemetry/api";
import { AgentLoader } from "../core/agent-loader.js";
import {
  AgentRunner,
  createSessionFromRun,
  type ModelProvider,
  type ModelRunParams,
} from "../core/agent-runner.js";
import { createAgentSessionManager, type AgentSessionManager } from "../core/agent-session.js";
import { createAgentLifecycleDispatcher } from "../core/agent-lifecycle.js";
import { createModelResolver } from "../core/model-resolver.js";
import { CapabilityDiscovery } from "../core/capability-discovery.js";
import { SkillCatalog } from "../core/skill-catalog.js";
import { SessionManager } from "../core/session-manager.js";
import { PromptBuilder } from "../core/prompt-builder.js";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import type { ChannelMessage } from "@rome-os/app-runtime";
import { withInboundSpans } from "../telemetry.js";
import type { Action } from "../actions/types.js";
import { channelList } from "../channels/channel-list.js";
import type { AgentEvent } from "../types.js";
import {
  createTestConnections,
  createTestDb,
  FakeTransport,
  noAccounts,
  type TestDb,
  createActionEngineRepos,
} from "./helpers.js";

export const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "agents");

/**
 * Minimal end-to-end rig for trace-assertion tests. Wires the same
 * composition-root path Rome uses in production so every span in the
 * channel→hook→agent→model→action chain is emitted from the same code
 * that runs in `packages/core/src/index.ts`.
 *
 * The only pure inputs are the `ModelProvider` (so tests drive a predictable
 * turn sequence) and the channel names (so tests can simulate inbound
 * messages without booting Telegram/Discord/WhatsApp transports). Inbound
 * reaches the rig's handler through the production channel list and the same
 * `withInboundSpans` instrumentation the channel-message hook hears through.
 */
export interface GoldenTraceRig {
  testDb: TestDb;
  transports: Map<string, FakeTransport>;
  actionEngine: ActionEngine;
  runner: AgentRunner;
  /** Direct AgentSessionManager handle — for tests that bypass the channel
   * adapter path (e.g. the webchat-style direct `sendTurn` flow). */
  manager: AgentSessionManager;
  /** Deliver one inbound message on `channel` through the real channel and
   *  instrumentation path, resolving once the rig's handler has finished
   *  with it. The message needs text, or the channel drops it (R2) and this
   *  never resolves. */
  simulateInbound(channel: string, overrides?: Partial<ChannelMessage>): Promise<void>;
  shutdown(): void;
}

export interface GoldenTraceOptions {
  modelProvider: ModelProvider;
  channels: string[];
  agentName: string;
  /** Tracer that ActionEngine will use for `action:*` spans. */
  tracer: Tracer;
  /** Additional actions to register (e.g., a test-only `demo_action`). */
  extraActions?: Action[];
  /** Override the agent-fixtures directory. Defaults to test fixtures. */
  fixturesDir?: string;
}

export async function buildGoldenTraceRig(options: GoldenTraceOptions): Promise<GoldenTraceRig> {
  const testDb = createTestDb();
  const sessionsRepo = new SessionsRepository(testDb.db);
  const sessionManager = new SessionManager(sessionsRepo);
  const promptBuilder = new PromptBuilder();
  const actionRegistry = new ActionRegistryImpl();
  const actionEngine = new ActionEngine(actionRegistry, createActionEngineRepos(testDb.db), {
    tracer: options.tracer,
  });

  const agentLoader = new AgentLoader();
  await agentLoader.loadAll(options.fixturesDir ?? FIXTURES_DIR);

  for (const action of options.extraActions ?? []) {
    actionRegistry.register(action);
  }

  const modelResolver = createModelResolver({
    providers: [options.modelProvider],
    aiToolState: {
      get: () => ({
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      }),
      refresh: async () => ({
        codex: { loggedIn: true, quotaExhausted: false, solAccess: true, lunaAccess: true },
        claude: { loggedIn: true, quotaExhausted: false },
      }),
    },
  });
  const manager = createAgentSessionManager({
    agentLoader,
    sessionManager,
    promptBuilder,
    actionRegistry,
    modelResolver,
    actionEngine,
    capabilityDiscovery: new CapabilityDiscovery(),
    skillCatalog: new SkillCatalog(),
    lifecycleDispatcher: createAgentLifecycleDispatcher(),
  });
  const runner = new AgentRunner(manager);

  const transports = new Map<string, FakeTransport>();
  for (const name of options.channels) {
    transports.set(name, new FakeTransport(name));
  }
  const channels = withInboundSpans(
    channelList({
      db: testDb.db,
      whatsAppAccounts: noAccounts,
      linkedInAccounts: noAccounts,
      connections: { registry: createTestConnections(transports) },
    }),
    "channel-message",
  );

  // The channel holds each message until its handler settles, so a delivery
  // resolves before the turn ends. This handler signals when a message is
  // done, by id.
  const handled = new Map<string, () => void>();

  // Subscribe the test's hook handler: drive the agent runner for the
  // configured `agentName`. This takes the place of the real inbox-app
  // channel-message hook (which has heavy deps — policy engine, person
  // repo, etc.) and keeps the rig focused on the trace shape.
  for (const channel of channels) {
    channel.inbound?.subscribe(async ({ message }) => {
      try {
        // drain — the test asserts via the span exporter, not via messages
        for await (const _m of runner.run({
          agentName: options.agentName,
          prompt: message.text,
          channelThreadKey: `${message.channel}:${message.conversationId}`,
          workingDir: "/tmp",
        })) {
          // intentionally empty
        }
      } finally {
        handled.get(message.messageId)?.();
      }
    });
  }

  return {
    testDb,
    transports,
    actionEngine,
    runner,
    manager,
    async simulateInbound(channel, overrides = {}) {
      const transport = transports.get(channel);
      if (!transport) throw new Error(`channel not registered: ${channel}`);
      const messageId = overrides.messageId ?? randomUUID();
      const done = new Promise<void>((resolve) => handled.set(messageId, resolve));
      await transport.receive({ ...overrides, messageId });
      await done;
      handled.delete(messageId);
    },
    shutdown() {
      testDb.close();
    },
  };
}

/** Convenience: a trivial provider that yields one tool_use + one result. */
export function makeSingleActionProvider(
  actionName: string,
  input: Record<string, unknown>,
): ModelProvider {
  const runImpl = async function* (params: ModelRunParams): AsyncIterable<AgentEvent> {
    const id = randomUUID();
    yield { type: "tool_use", id, tool: actionName, input };
    await params.executeAction(actionName, input);
    yield { type: "tool_result", toolUseId: id, tool: actionName, output: { success: true } };
    yield {
      type: "result",
      content: "done",
      accounting: {
        provider: "mock",
        model: params.model,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        costUsd: 0.001,
        numTurns: 1,
        stopReason: "end_turn",
      },
    };
  };
  return {
    id: "mock",
    displayName: "mock-single-action",
    builtinTools: new Set<string>(),
    openSession: async (params) => createSessionFromRun("mock", runImpl, params),
  };
}
