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
import { createDataTier } from "../composition/data-tier.js";
import { wrapProviderAdaptersWithSpans } from "../telemetry.js";
import type { ProviderAdapter } from "../channels/adapter.js";
import type { Action } from "../actions/types.js";
import type { NormalizedMessage, AgentMessage } from "../types.js";
import { createTestDb, MockProviderAdapter, type TestDb } from "./helpers.js";

export const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "agents");

/**
 * Minimal end-to-end rig for trace-assertion tests. Wires the same
 * composition-root path Rome uses in production so every span in the
 * channel→hook→agent→model→action chain is emitted from the same code
 * that runs in `packages/core/src/index.ts`.
 *
 * The only pure inputs are the `ModelProvider` (so tests drive a predictable
 * turn sequence) and the channel names (so tests can simulate inbound
 * messages without booting Telegram/Discord/WhatsApp transports).
 */
export interface GoldenTraceRig {
  testDb: TestDb;
  adapters: Map<string, MockProviderAdapter>;
  actionEngine: ActionEngine;
  runner: AgentRunner;
  /** Direct AgentSessionManager handle — for tests that bypass the channel
   * adapter path (e.g. the webchat-style direct `sendTurn` flow). */
  manager: AgentSessionManager;
  /** Simulate one inbound message through the real wrapping + hook path. */
  simulateInbound(channel: string, msg: NormalizedMessage): Promise<void>;
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
  const { sessionsRepo } = createDataTier(testDb.db);
  const sessionManager = new SessionManager(sessionsRepo);
  const promptBuilder = new PromptBuilder();
  const actionRegistry = new ActionRegistryImpl([]);
  const actionEngine = new ActionEngine(actionRegistry, options.tracer);

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

  const adapters = new Map<string, MockProviderAdapter>();
  for (const name of options.channels) {
    adapters.set(name, new MockProviderAdapter(name));
  }

  wrapProviderAdaptersWithSpans(adapters);

  // Register the test's hook handler: drive the agent runner for the
  // configured `agentName`. This takes the place of the real inbox-app
  // channel-message hook (which has heavy deps — policy engine, person
  // repo, etc.) and keeps the rig focused on the trace shape.
  for (const adapter of adapters.values()) {
    adapter.onMessage(async (msg: NormalizedMessage) => {
      // drain — the test asserts via the span exporter, not via messages
      for await (const _m of runner.run({
        agentName: options.agentName,
        prompt: msg.text,
        channelThreadKey: `${msg.channel}:${msg.threadId}`,
        workingDir: "/tmp",
      })) {
        // intentionally empty
      }
    });
  }

  return {
    testDb,
    adapters,
    actionEngine,
    runner,
    manager,
    async simulateInbound(channel, msg) {
      const adapter = adapters.get(channel);
      if (!adapter) throw new Error(`channel not registered: ${channel}`);
      await adapter.simulateMessage(msg);
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
  const runImpl = async function* (params: ModelRunParams): AsyncIterable<AgentMessage> {
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
