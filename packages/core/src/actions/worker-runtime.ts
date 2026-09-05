import { loadConfig } from "../config.js";
import { getDb } from "../db/index.js";
import { AgentLoader } from "../core/agent-loader.js";
import { ActionRegistryImpl } from "./registry.js";
import { ActionLoader } from "./loader.js";
import { ActionEngine } from "./engine.js";
import { emitAgentMessage } from "./runtime-events.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import { ExecutionJournalRepository } from "../db/repositories/execution-journal.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { PoliciesRepository } from "../db/repositories/policies.js";
import { RpcAgentRunner } from "../core/rpc-agent-runner.js";
import { CapabilityDiscovery } from "../core/capability-discovery.js";
import { PolicyEngine } from "../core/policy-engine.js";
import { ensureProfileMemoryInitialized, resolveProfileMemoryPath } from "../profile-memory.js";
import {
  ActionRegistryProxy,
  AppManagerProxy,
  AppStoreProxy,
  ConversationSettingsControlProxy,
  EmailInboundControlProxy,
  BackendTurnRunnerProxy,
  ChildSessionsProxy,
  EventBusProxy,
  EventCatalogProxy,
  NotifyServiceProxy,
  RoutineEngineProxy,
  SystemUpgradeServiceProxy,
  TalkRouterProxy,
} from "./service-proxies.js";
import { AppCatalog, AppInstaller, hydrateCatalogFromLockfile } from "../apps/index.js";
import { readLockfileWithEntryIsolation } from "../apps/lockfile.js";
import { createAppRuntimeRepositories } from "../apps/repositories.js";
import { SkillCatalog } from "../core/skill-catalog.js";
import { registerLazyAppActions } from "./app-actions-wiring.js";
import {
  createCodexImageGenerationProvider,
  createImageGenerationService,
} from "../capabilities/image-generation/index.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { STRANGER_PERSON_ID } from "../constants.js";
import { getProfileAppsLockfilePath, getProfileInstalledAppsDir } from "../paths.js";
import { createLogger } from "../logger.js";
import {
  ARTIFACT_LEGACY_BINDINGS_SETTING,
  parseLegacyArtifactBindings,
} from "../apps/artifact-id.js";
import { createArtifactReferenceResolver } from "../apps/artifact-reference.js";

const log = createLogger("action-worker");

export async function createWorkerActionEngine(): Promise<ActionEngine> {
  const config = loadConfig();
  ensureProfileMemoryInitialized();
  const db = getDb(config.database);

  // Read-only worker view of the apps domain: hydrate one complete catalog
  // snapshot, then load its artifacts. Loading on every incremental hydration
  // event exposes invalid partial state (for example, main can reference a
  // subagent whose owning app has not been hydrated yet) and repeats the same
  // expected startup error once per loader and app. Workers are invalidated by
  // the main process when apps change, so they do not need local subscribers.
  // The worker must not call AppManager.boot(): boot owns main-process recovery
  // work such as staging sweeps, probes, migrations, and lockfile writes.
  const lockfilePath = getProfileAppsLockfilePath();
  const appInstaller = new AppInstaller({
    installedRoot: getProfileInstalledAppsDir(),
  });
  const appCatalog = new AppCatalog({
    installer: appInstaller,
    readLockfileEntry: async (appId) => {
      const { lockfile } = await readLockfileWithEntryIsolation(lockfilePath);
      return lockfile.apps[appId] ?? null;
    },
    getInFlight: () => undefined,
    markBroken: async () => {},
  });
  const settingsRepo = new SettingsRepository(db);
  const artifactIdentity = {
    legacyBindings: parseLegacyArtifactBindings(
      await settingsRepo.get(ARTIFACT_LEGACY_BINDINGS_SETTING),
    ),
  };
  const agentLoader = new AgentLoader(artifactIdentity);
  const skillCatalog = new SkillCatalog(artifactIdentity);
  const actionLoader = new ActionLoader(artifactIdentity);
  // The worker executes actions dispatched from main; it never resolves
  // per-agent tool visibility, so it needs no globally-granted action names.
  const actionRegistry = new ActionRegistryImpl([], artifactIdentity);
  await hydrateCatalogFromLockfile({
    lockfilePath,
    catalog: appCatalog,
  });
  await agentLoader.loadFromCatalog(appCatalog);
  await actionLoader.loadFromCatalog(appCatalog);
  await skillCatalog.loadFromCatalog(appCatalog);

  const personMappingRepo = new PersonMappingRepository(db);
  const sentinelLogRepo = new SentinelLogRepository(db);
  const approvalsRepo = new ApprovalsRepository(db);
  const webchatRepo = new WebChatRepository(db);
  const appRuntimeRepositories = createAppRuntimeRepositories({ settingsRepo, webchatRepo });
  const policiesRepo = new PoliciesRepository(db);
  const routinesRepo = new RoutinesRepository(db);
  const actionExecutionsRepo = new ActionExecutionsRepository(db);
  const executionJournalRepo = new ExecutionJournalRepository(db);

  const talkRouter = new TalkRouterProxy();
  const conversationSettings = new ConversationSettingsControlProxy();
  const policyEngine = new PolicyEngine(policiesRepo, settingsRepo);

  const actionEngine = new ActionEngine(
    actionRegistry,
    undefined,
    actionExecutionsRepo,
    approvalsRepo,
    executionJournalRepo,
    {
      processRole: "worker",
      onApprovalCreated: async ({ approvalId, actionName, preview, channelContext }) => {
        if (!channelContext) return;
        const matches = (await talkRouter.list()).filter(
          (connection) => connection.service === channelContext.channel,
        );
        const connectionId =
          channelContext.connectionId ??
          (matches.length === 1 ? matches[0]!.connectionId : undefined);
        if (!connectionId) return;
        const payload = preview ?? {
          kind: "generic" as const,
          title: actionName,
          summary: `The agent wants to run "${actionName}" and needs your approval.`,
        };
        await talkRouter.send(
          connectionId,
          channelContext.threadId as import("@rome-os/app-runtime").ConversationId,
          {
            parts: [
              {
                type: "approval_card",
                approvalId,
                actionName,
                preview: payload,
                status: "pending",
              },
            ],
          },
        );
      },
    },
  );
  const capabilityDiscovery = new CapabilityDiscovery();
  // Fire-and-forget: tailscale-based remote discovery is low-priority, and its
  // initial `tailscale status` probe blocks ~2s when the daemon isn't running.
  // Awaiting it here would put that cost on every forked worker's engine-build
  // critical path (e.g. send_message); let it warm up in the background instead.
  void capabilityDiscovery.start().catch(() => {
    // Best effort in workers.
  });

  const agentRunner = new RpcAgentRunner();
  const resolveArtifactReference = createArtifactReferenceResolver({
    agentLoader,
    actionRegistry,
  });

  const appActionReload = registerLazyAppActions(
    actionLoader,
    actionRegistry,
    appCatalog,
    {
      agentRunner,
      resolveArtifactReference,
      talkRouter,
      conversationSettings,
      capabilityDiscovery,
      personMappingRepo,
      sentinelLogRepo,
      approvalsRepo,
      policyEngine,
      routinesRepo,
      // Worker actions reach the live main-process services over RPC. Injecting
      // the proxies here (the real coordinators are injected in the main
      // process) lets the event/app-lifecycle actions call their dep directly
      // without branching on which process they run in.
      routineEngine: new RoutineEngineProxy(),
      eventBus: new EventBusProxy(),
      eventCatalog: new EventCatalogProxy(),
      appStore: new AppStoreProxy(),
      appManager: new AppManagerProxy(),
      emailInbound: new EmailInboundControlProxy(),
      systemUpgrade: new SystemUpgradeServiceProxy(),
      backendTurnRunner: new BackendTurnRunnerProxy(),
      childSessions: new ChildSessionsProxy(),
      notify: new NotifyServiceProxy(),
      actionEngine,
      actionRegistry: new ActionRegistryProxy(),
      emitAgentMessage,
      resolveProfilePath: resolveProfileMemoryPath,
      strangerPersonId: STRANGER_PERSON_ID,
      // Same capability the main process wires, minus AiToolState (main-only):
      // the worker-side Codex provider reports available and relies on the
      // pinned image_gen agent's model resolution failing closed in main, whose
      // error streams back over RPC with its machine-readable code.
      imageGeneration: createImageGenerationService({
        providers: [createCodexImageGenerationProvider({ agentRunner })],
      }),
    },
    { db, actionEngine, routinesRepo, repositories: appRuntimeRepositories },
  );
  if (agentLoader.getRegistryLoadFailures().length > 0) {
    log.warn("some app agents failed to load", {
      failures: agentLoader.getRegistryLoadFailures(),
    });
  }
  if (skillCatalog.getRegistryLoadFailures().length > 0) {
    log.warn("some app skills failed to load", {
      failures: skillCatalog.getRegistryLoadFailures(),
    });
  }
  if (actionLoader.getRegistryLoadFailures().length > 0) {
    log.warn("some app action configs failed to load", {
      failures: actionLoader.getRegistryLoadFailures(),
    });
  }
  if (appActionReload.failed.length > 0) {
    log.warn("some app actions failed to initialize", {
      failures: appActionReload.failed,
    });
  }

  return actionEngine;
}
