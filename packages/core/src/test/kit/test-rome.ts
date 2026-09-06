import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";

import type { Tracer } from "@opentelemetry/api";

import { createTestDb, buildAgentConfig, createMockTalkRouter } from "../helpers.js";
import { FakeModel } from "./fake-model.js";
import { FakeChannelEndpoint } from "./fake-channel.js";
import type { DrizzleDb } from "../../db/index.js";
import { SessionsRepository } from "../../db/repositories/sessions.js";
import { ApprovalsRepository } from "../../db/repositories/approvals.js";
import { ExecutionJournalRepository } from "../../db/repositories/execution-journal.js";
import { ActionExecutionsRepository } from "../../db/repositories/action-executions.js";
import { SettingsRepository } from "../../db/repositories/settings.js";
import { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import { PoliciesRepository } from "../../db/repositories/policies.js";
import { ActionRegistryImpl } from "../../actions/registry.js";
import { ActionEngine, type ApprovalCreatedEvent } from "../../actions/engine.js";
import { ApprovalHandler } from "../../actions/approval-handler.js";
import { createBackendTurnRunner } from "../../actions/backend-turn.js";
import type { Action } from "../../actions/types.js";
import { AgentLoader } from "../../core/agent-loader.js";
import { SessionManager } from "../../core/session-manager.js";
import { PromptBuilder } from "../../core/prompt-builder.js";
import { createModelResolver } from "../../core/model-resolver.js";
import { createAgentSessionManager } from "../../core/agent-session.js";
import { createAgentTurnStreamRegistry } from "../../core/agent-turn-stream-registry.js";
import { createAgentLifecycleDispatcher } from "../../core/agent-lifecycle.js";
import { CapabilityDiscovery } from "../../core/capability-discovery.js";
import { SkillCatalog } from "../../core/skill-catalog.js";
import { AgentRunner } from "../../core/agent-runner.js";
import type { RunParams } from "../../core/types.js";
import type { TalkRouter } from "@rome-os/app-runtime";
import type { AgentConfig, AgentMessage } from "../../types.js";
import type { Clock } from "../../lib/clock.js";
import type { ActionSubprocessRunner } from "../../actions/action-subprocess.js";

// createTestRome — boot the real runtime wiring over an in-memory DB and a
// temp profile, faking only genuine process edges (model provider, channel
// transport). Repos, engine, session manager, prompt builder, runner and
// approval handler are all the production classes, so tests assert outcomes
// (DB rows, outbound messages, prompts the model saw) instead of stub calls.

export interface TestRomeOptions {
  /** Agent configs to load (written as YAML and loaded by the real AgentLoader).
   *  Defaults to a single agent named "main". */
  agents?: AgentConfig[];
  /** Actions registered into the real ActionRegistry / ActionEngine. */
  actions?: Action[];
  /** Channel names to expose as FakeChannelEndpoints. */
  channels?: string[];
  /** Forwarded to the agent session manager (Phase 4 keep-alive). */
  keepAliveAcrossTurns?: boolean;
  /**
   * "real" (default) keeps the caller's project/core roots, so PromptBuilder
   * reads the production repo context (CHARTER.md, repo apps) — versioned
   * content, deterministic everywhere. "empty" points them at the sandbox for
   * tests that want a bare repo view.
   */
  repoView?: "real" | "empty";
  /**
   * Wiring variations of the real ActionEngine, mirroring how the daemon
   * constructs it. `processRole` defaults to "worker" so root actions execute
   * in-process (the subprocess fork is the edge the kit avoids); tests that
   * exercise the main-role fork orchestration pass "main" and stub the fork
   * itself. `onApprovalCreated` is the daemon's approval-card callback;
   * `tracer` enables real `action:*` spans. `clock` injects a time source
   * (pass a FakeClock to make durations and timer firing deterministic).
   */
  engine?: {
    tracer?: Tracer;
    processRole?: "main" | "worker";
    onApprovalCreated?: (event: ApprovalCreatedEvent) => Promise<void> | void;
    clock?: Clock;
    actionSubprocessRunner?: ActionSubprocessRunner;
  };
}

export interface TestRomeRepos {
  sessions: SessionsRepository;
  approvals: ApprovalsRepository;
  executionJournal: ExecutionJournalRepository;
  actionExecutions: ActionExecutionsRepository;
  settings: SettingsRepository;
  personMapping: PersonMappingRepository;
  policies: PoliciesRepository;
}

/** Loose on purpose: tests seed malformed payloads to exercise validation. */
export type ActionExecutionPayload = Record<string, unknown> | null;

export interface TestRomeSeed {
  /** Insert a pending action_execution approval; returns its id. */
  pendingActionApproval(payload: ActionExecutionPayload): Promise<string>;
  /** Insert an approval and resolve it approved (execution queued); returns its id. */
  approvedActionApproval(payload: ActionExecutionPayload): Promise<string>;
}

export interface TestRome {
  db: DrizzleDb;
  repos: TestRomeRepos;
  model: FakeModel;
  actionRegistry: ActionRegistryImpl;
  actionEngine: ActionEngine;
  agentLoader: AgentLoader;
  agentRunner: AgentRunner;
  approvalHandler: ApprovalHandler;
  talkRouter: TalkRouter;
  seed: TestRomeSeed;
  channel(name: string): FakeChannelEndpoint;
  /** Run one agent turn through the real runner/session stack; collects messages. */
  runAgent(params: Partial<RunParams> & { prompt: string }): Promise<AgentMessage[]>;
  cleanup(): Promise<void>;
}

const SCOPED_ENV_KEYS = [
  "ROME_PROFILE",
  "ROME_PROJECT_ROOT",
  "ROME_CORE_ROOT",
  "ROME_PROJECTS_ROOT",
  "HOME",
  "USERPROFILE",
] as const;

// Env scoping mutates process-global state, so harnesses must run strictly
// sequentially. Fail fast on overlap instead of letting the first cleanup()
// silently reset the env out from under the second harness.
let activeHarnessRoot: string | null = null;

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

export async function createTestRome(options: TestRomeOptions = {}): Promise<TestRome> {
  if (activeHarnessRoot !== null) {
    throw new Error(
      `createTestRome: another harness is already active (${activeHarnessRoot}). ` +
        `Harnesses scope ambient HOME/ROME_* env, so they cannot be nested or run ` +
        `concurrently in one process — await the previous harness's cleanup() first.`,
    );
  }
  const root = mkdtempSync(join(tmpdir(), "rome-testkit-"));
  activeHarnessRoot = root;

  // Path resolution is ambient (env + homedir) until it grows a real seam, so
  // scope the WRITE-backed locations into the sandbox: HOME is redirected so
  // getProfileDir() — and with it any profile-backed write (memory init, app
  // data, lockfiles) — resolves under `root` and is deleted on cleanup, never
  // under the developer's real ~/.rome; projects root likewise. Read-only
  // repo roots (project/core: CHARTER.md, repo apps) stay real by default so
  // PromptBuilder produces the production system prompt — they're versioned
  // content, equally deterministic everywhere.
  const savedEnv = new Map<string, string | undefined>(
    SCOPED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const restoreEnv = () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  process.env.ROME_PROFILE = `testkit-${randomUUID()}`;
  process.env.ROME_PROJECTS_ROOT = join(root, "projects");
  process.env.HOME = root;
  process.env.USERPROFILE = root; // homedir() on Windows
  if (options.repoView === "empty") {
    process.env.ROME_PROJECT_ROOT = root;
    process.env.ROME_CORE_ROOT = root;
  }

  try {
    return await buildHarness(root, restoreEnv, options);
  } catch (err) {
    restoreEnv();
    activeHarnessRoot = null;
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

async function buildHarness(
  root: string,
  restoreEnv: () => void,
  options: TestRomeOptions,
): Promise<TestRome> {
  const testDb = createTestDb();
  const db = testDb.db;

  const repos: TestRomeRepos = {
    sessions: new SessionsRepository(db),
    approvals: new ApprovalsRepository(db),
    executionJournal: new ExecutionJournalRepository(db),
    actionExecutions: new ActionExecutionsRepository(db),
    settings: new SettingsRepository(db),
    personMapping: new PersonMappingRepository(db),
    policies: new PoliciesRepository(db),
  };

  // Agents: write YAML to a temp dir and load through the real AgentLoader so
  // schema validation and tier mapping run exactly as in production.
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir, { recursive: true });
  // Wildcard actions so registered test actions are callable without each
  // test re-declaring an allow-list; pass explicit agents to test the gating.
  const agents = options.agents ?? [buildAgentConfig({ name: "main", actions: ["*"] })];
  for (const agent of agents) {
    await writeFile(
      join(agentsDir, `${agent.name}.yaml`),
      stringifyYaml(stripUndefined(agent as unknown as Record<string, unknown>)),
      "utf-8",
    );
  }
  const agentLoader = new AgentLoader();
  await agentLoader.loadAll(agentsDir);

  const model = new FakeModel();
  const modelResolver = createModelResolver({
    providers: [model],
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

  const actionRegistry = new ActionRegistryImpl([]);
  for (const action of options.actions ?? []) {
    actionRegistry.register(action);
  }

  // processRole "worker" executes root actions in-process — the subprocess
  // fork is the edge the kit avoids.
  const actionEngine = new ActionEngine(
    actionRegistry,
    options.engine?.tracer,
    repos.actionExecutions,
    repos.approvals,
    repos.executionJournal,
    {
      processRole: options.engine?.processRole ?? "worker",
      onApprovalCreated: options.engine?.onApprovalCreated,
      clock: options.engine?.clock,
      actionSubprocessRunner: options.engine?.actionSubprocessRunner,
    },
  );

  const sessionManager = new SessionManager(repos.sessions);
  const promptBuilder = new PromptBuilder();
  const agentTurnStreamRegistry = createAgentTurnStreamRegistry();
  const agentSessionManager = createAgentSessionManager(
    {
      agentLoader,
      sessionManager,
      promptBuilder,
      actionRegistry,
      modelResolver,
      actionEngine,
      // Real but inert collaborators: CapabilityDiscovery is never start()ed
      // (no timers, empty CDP map) and the dispatcher has no hooks loaded.
      capabilityDiscovery: new CapabilityDiscovery(),
      skillCatalog: new SkillCatalog(),
      lifecycleDispatcher: createAgentLifecycleDispatcher(),
      // Match production wiring so resume-by-id paths hit the live-turn guard.
      turnStreams: agentTurnStreamRegistry,
    },
    { keepAliveAcrossTurns: options.keepAliveAcrossTurns ?? false },
  );
  const agentRunner = new AgentRunner(agentSessionManager, agentLoader);

  const channelEndpoints = new Map<string, FakeChannelEndpoint>();
  for (const name of options.channels ?? ["telegram", "webchat"]) {
    channelEndpoints.set(name, new FakeChannelEndpoint(name));
  }
  const talkRouter = createMockTalkRouter(channelEndpoints);

  const backendTurnRunner = createBackendTurnRunner({
    agentRunner,
    talkRouter,
  });
  const approvalHandler = new ApprovalHandler(
    repos.approvals,
    repos.executionJournal,
    actionEngine,
    agentRunner,
    backendTurnRunner,
  );

  let cleaned = false;

  const seed: TestRomeSeed = {
    pendingActionApproval: (payload) =>
      repos.approvals.create({
        type: "action_execution",
        requestedBy: "testkit",
        description:
          typeof payload?.actionName === "string"
            ? `Execute ${payload.actionName}`
            : "test approval",
        payload,
      }),
    approvedActionApproval: async (payload) => {
      const id = await seed.pendingActionApproval(payload);
      const resolved = await repos.approvals.resolvePending(id, "approve");
      if (resolved.outcome !== "resolved") {
        throw new Error(`Failed to approve seeded approval ${id}: ${resolved.outcome}`);
      }
      return id;
    },
  };

  return {
    db,
    repos,
    model,
    actionRegistry,
    actionEngine,
    agentLoader,
    agentRunner,
    approvalHandler,
    talkRouter,
    seed,
    channel(name: string): FakeChannelEndpoint {
      const endpoint = channelEndpoints.get(name);
      if (!endpoint) {
        throw new Error(
          `Channel "${name}" not configured — pass it via createTestRome({ channels })`,
        );
      }
      return endpoint;
    },
    async runAgent(params) {
      const messages: AgentMessage[] = [];
      for await (const msg of agentRunner.run({ agentName: "main", ...params })) {
        messages.push(msg);
      }
      return messages;
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await actionEngine.stopWorkerWarmPool();
      await agentSessionManager.shutdown();
      testDb.close();
      await rm(root, { recursive: true, force: true });
      restoreEnv();
      activeHarnessRoot = null;
    },
  };
}
