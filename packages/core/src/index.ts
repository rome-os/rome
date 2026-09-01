import { dirname, join } from "node:path";
import { fork } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { resolveCloudAuthEnabled } from "./lib/cloud-auth-gate.js";
import { createLogger } from "./logger.js";
import {
  getInstanceToken,
  hydrateInstanceToken,
  logInstanceIdentityAtBoot,
  seedInstanceTokenFromEnv,
} from "./lib/instance-identity.js";
import { startInstanceIdentityHeartbeat } from "./lib/instance-identity-heartbeat.js";
import { NotifyClient } from "./lib/notify-client.js";
import { recordResolvedAccount } from "./lib/guardian-auth-state.js";
import { systemClock } from "./lib/clock.js";
import { provisionRelayMailboxAtBoot } from "./lib/rome-cloud-relay.js";
import { getConfiguredInstanceOrigin } from "./lib/rome-cloud-origin.js";
import { reportBootVersion, commitBootVersion } from "./lib/boot-version-report.js";
import { getBuildInfo } from "./build-info.js";
import { initTelemetry, getTracer, shutdown as shutdownTelemetry } from "./telemetry.js";

const log = createLogger("startup");

// Bound on `shutdownTelemetry()` so a degraded OTLP collector (e.g. `rome-obs`
// restarting) can't wedge a crashing process on the BatchLogRecordProcessor's
// default flush timeout. 2s is generous for a same-Docker-network OTLP flush of
// a single ERROR record; anything slower means obs is down and exiting without
// the flush is the right call. Mirrors the worker's flush-on-exit bound.
const FATAL_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Flush the OTLP pipeline (bounded), then hard-exit. Used on the fatal paths
 * (uncaughtException / unhandledRejection / fatal-boot) where we've already
 * logged an ERROR through `createLogger` and must guarantee that record reaches
 * ClickStack before the process dies — without hanging on a slow collector.
 */
async function flushTelemetryThenExit(exitCode: number): Promise<never> {
  try {
    await Promise.race([
      shutdownTelemetry(),
      new Promise<void>((resolve) => setTimeout(resolve, FATAL_FLUSH_TIMEOUT_MS)),
    ]);
  } finally {
    process.exit(exitCode);
  }
}
import { getDb, type DrizzleDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { SessionsRepository } from "./db/repositories/sessions.js";
import { PersonMappingRepository } from "./db/repositories/person-mapping.js";
import { LinkedInStoreRepository } from "./db/repositories/linkedin-store.js";
import { WhatsAppStoreRepository } from "./db/repositories/whatsapp-store.js";
import { LinkedInAccounts } from "./channels/linkedin-accounts.js";
import { WhatsAppAccounts } from "./channels/whatsapp-accounts.js";
import { createAccountNames } from "./channels/account-names.js";
import { channelList } from "./channels/channel-list.js";
import { SentinelLogRepository } from "./db/repositories/sentinel-log.js";
import { ApprovalsRepository } from "./db/repositories/approvals.js";
import { SettingsRepository } from "./db/repositories/settings.js";
import { AppKeysRepository } from "./db/repositories/app-keys.js";
import { AppKeyInjector } from "./app-keys/injector.js";
import { PoliciesRepository } from "./db/repositories/policies.js";
import { WebChatRepository } from "./db/repositories/webchat.js";
import { ActionExecutionsRepository } from "./db/repositories/action-executions.js";
import { ExecutionJournalRepository } from "./db/repositories/execution-journal.js";
import { WebhookInvocationsRepository } from "./db/repositories/webhook-invocations.js";
import { ensureSentinelPersons } from "./db/ensure-sentinel-persons.js";
import { AgentLoader } from "./core/agent-loader.js";
import { SessionManager } from "./core/session-manager.js";
import { PromptBuilder } from "./core/prompt-builder.js";
import { ActionRegistryImpl } from "./actions/registry.js";
import {
  GLOBALLY_GRANTED_ACTIONS,
  resolveGlobalActionNames,
  validateGlobalActions,
} from "./actions/global-actions.js";
import { ActionLoader } from "./actions/loader.js";
import { ActionEngine } from "./actions/engine.js";
import { bumpModuleEnvEpoch } from "./actions/module-loader.js";
import { ActionWorkerCoordinator } from "./actions/action-subprocess.js";
import { WorkerRpcServer } from "./actions/worker-rpc.js";
import { setWorkerRpcInProcessDispatcher } from "./actions/worker-rpc-client.js";
import { AgentRunner } from "./core/agent-runner.js";
import { AnthropicProvider } from "./core/anthropic-provider.js";
import { CodexAppServerProvider } from "./core/codex-app-server-provider.js";
import { CodexAppServerManager } from "./core/codex/app-server-manager.js";
import { SharedCodexAccountService } from "./core/codex/account-service.js";
import { createAIToolState } from "./core/ai-tool-state.js";
import { createModelResolver } from "./core/model-resolver.js";
import { createConversationTitleGenerator } from "./core/conversation-title.js";
import { createAgentSessionManager } from "./core/agent-session.js";
import { createAgentLifecycleDispatcher } from "./core/agent-lifecycle.js";
import { createTurnMiddlewareChain } from "./core/turn-middleware.js";
import { AgentSessionBridge } from "./core/agent-session-bridge.js";
import { CapabilityDiscovery } from "./core/capability-discovery.js";
import { EventBus } from "./events/event-bus.js";
import { EventService } from "./events/event-service.js";
import { RoutinesRepository } from "./db/repositories/routines.js";
import { RoutineRunsRepository } from "./db/repositories/routine-runs.js";
import { RoutineEngine } from "./routines/engine.js";
import { EventCatalog } from "./event-catalog.js";
import { ScheduleTriggerProvider } from "./routines/schedule-trigger-provider.js";
import { resolveGuardianTimezone } from "./routines/guardian-timezone.js";
import { EventBusTriggerProvider } from "./routines/event-bus-trigger-provider.js";
import { ManualTriggerProvider } from "./routines/manual-trigger-provider.js";
import { migrateEventsToRoutines } from "./routines/migrate-events-to-routines.js";
import { mapGuardianToChannel } from "./channels/guardian-mapping.js";
import type { EmailInboundResult } from "./channels/email-control.js";
import { startApi, type ApiHandle, type ApiDeps } from "./api/index.js";
import { SystemUpgradeService } from "./system-upgrade/service.js";
import { resolveAutoUpgradeEnabled } from "./lib/auto-upgrade-gate.js";
import { PublicAccessState } from "./lib/public-access-state.js";
import { DashboardAccessState } from "./lib/dashboard-access-state.js";
import { ApprovalHandler } from "./actions/approval-handler.js";
import { createBackendTurnRunner } from "./actions/backend-turn.js";
import { emitAgentMessage } from "./actions/runtime-events.js";
import { PolicyEngine } from "./core/policy-engine.js";
import { ensureProfileMemoryInitialized, resolveProfileMemoryPath } from "./profile-memory.js";
import { ensureProfileExampleAppsSeeded } from "./profile-example-apps.js";
import type { EmailAdapter, EmailSettings } from "./channels/email.js";
import { resolveWebchatContinuationWorkingDir } from "./webchat/projects.js";
import { SkillCatalog } from "./core/skill-catalog.js";
import { createActiveSubagentRegistry } from "./core/active-subagent-registry.js";
import { createAgentTurnStreamRegistry } from "./core/agent-turn-stream-registry.js";
import { createSubagentExecutionService } from "./core/subagent-execution.js";
import { assertCoreRequiredAppsPacked, deriveCoreRequiredApps } from "./apps/core-required.js";
import { installFirstPartyAppsAtBoot } from "./apps/boot-upgrade.js";
import { createRomeCloudListingClient } from "./apps/rome-cloud-listing-client.js";
import { createArtifactReferenceResolver } from "./apps/artifact-reference.js";
import {
  ensureProfileDevAppsDirInitialized,
  getProfileAppsLockfilePath,
  getProfileInstalledAppsDir,
  getProjectRoot,
} from "./paths.js";
import {
  createAppActionsSubscriber,
  createNoopChannelMessageHook,
  createChannelMessageHookFromCatalog,
  createChannelMessageHookReloader,
  registerAppActions,
} from "./actions/app-actions-wiring.js";
import type { ChannelMessageHook } from "./hooks/types.js";
import {
  createCodexImageGenerationProvider,
  createImageGenerationService,
} from "./capabilities/image-generation/index.js";
import { STRANGER_PERSON_ID } from "./constants.js";
import {
  buildRuntimeStatusEntries,
  createRuntimeStatusSubscriber,
  createRuntimeStatusFailureTracker,
  writeAppRuntimeStatus,
} from "./apps/runtime-status-subscriber.js";
import { createAppDomain, createBundleFetcher } from "./apps/index.js";
import { createAppStoreService } from "./apps/store-service.js";
import { AppLifecycleService } from "./apps/lifecycle-service.js";
import { createAppRuntimeRepositories } from "./apps/repositories.js";
import {
  ARTIFACT_LEGACY_BINDINGS_SETTING,
  isCoreMainAgentId,
  parseLegacyArtifactBindings,
} from "./apps/artifact-id.js";
import { ConnectionRegistry, DrizzleGrantLedger, createTalkRouter } from "./connections/index.js";
import { SetupManager } from "./connections/setup/manager.js";
import { registerBuiltinConnections } from "./connections/integrations/index.js";
import {
  ConversationSettingsRepository,
  ConversationSettingsService,
  cutoverConversationSettings,
} from "./conversation-settings/index.js";
import { importChannelSettings } from "./connections/settings-import.js";
import { reconcileProviderAccounts } from "./connections/providers-import.js";
import { createAppDbMigrationSubscriber } from "./apps/db-migration-subscriber.js";
import type { ResolvedApp } from "./apps/state.js";
import type { RomeAppRuntimeServices } from "./apps/context.js";
import { AppApiDispatcher } from "./apps/api.js";
import { RelayDrainer, buildRelayReplayRequest } from "./relay/drainer.js";
import {
  RELAY_SETTING_KEY,
  deriveDepositUrl,
  resolveRelayDrains,
  relayDrainsEqual,
  sanitizeDrainUrl,
  type RelayDrainSetting,
} from "./relay/settings.js";
import { RomeCloudFavorService } from "./favors/rome-cloud-service.js";
import { FavorDispatchRunner } from "./favors/dispatcher.js";
import {
  syncFavorActionRequirementsForCatalogEvent,
  syncFavorActionRequirementsFromCatalog,
} from "./favors/catalog-sync.js";

async function main() {
  const config = loadConfig();

  if (config.database.type === "sqlite") {
    const dbPath = config.database.sqlitePath;
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  ensureProfileMemoryInitialized();
  ensureProfileDevAppsDirInitialized();
  // Seed example/reference apps (e.g. morning-brief) into projects/example-apps
  // as editable starters — copy-if-missing, never installed, never clobbering edits.
  ensureProfileExampleAppsSeeded();

  initTelemetry();
  const tracer = getTracer("rome");

  const db: DrizzleDb = getDb(config.database);

  // Bare system migrations first; app migrations are run after the catalog
  // boots so we have the resolved DB metadata for each installed app.
  // System migrations are load-bearing: every repository, agent, and channel
  // adapter wired below assumes the resolved schema. Booting on a stale/partial
  // schema produces cascading, misleading failures downstream, so a failure
  // here aborts boot with a single structured root-cause ERROR (flushed to
  // ClickStack) rather than degrading. Re-thrown to `main().catch`, which owns
  // the bounded flush + exit.
  try {
    await runMigrations(config.database);
  } catch (err) {
    log.error("System migration failed at boot; aborting startup", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }

  const sessionsRepo = new SessionsRepository(db);
  const personMappingRepo = new PersonMappingRepository(db);
  const whatsAppStoreRepo = new WhatsAppStoreRepository(db);
  const whatsAppAccounts = new WhatsAppAccounts(whatsAppStoreRepo);
  const linkedInStoreRepo = new LinkedInStoreRepository(db);
  const linkedInAccounts = new LinkedInAccounts(linkedInStoreRepo);
  const sentinelLogRepo = new SentinelLogRepository(db);
  const channels = channelList({ db, whatsAppAccounts, linkedInAccounts });
  const accountNames = createAccountNames({ channels, sentinelLogRepo });
  const approvalsRepo = new ApprovalsRepository(db);
  const settingsRepo = new SettingsRepository(db);

  // Instance token: the DB is the single runtime read path. A cloud VM
  // gets ROME_INSTANCE_TOKEN injected into its env — seed it into the DB so the
  // runtime reads one place (upserts every boot, so a rotated env token follows).
  // Desktop/local have no env token and enroll later via the in-app OAuth flow;
  // either way, hydrate the in-memory cache from the DB before anything reads it.
  if (await seedInstanceTokenFromEnv(settingsRepo)) {
    log.info("Seeded instance token from environment into database");
  }
  await hydrateInstanceToken(settingsRepo);

  // App keys: guardian-entered values go live in process.env before any app
  // code, action worker, or route can read them. Operator-set env always wins;
  // the injector records those as overridden instead of clobbering.
  const appKeysRepo = new AppKeysRepository(db);
  const appKeyInjector = new AppKeyInjector();
  for (const row of await appKeysRepo.listWithValues()) {
    appKeyInjector.apply(row.name, row.value);
  }

  const policiesRepo = new PoliciesRepository(db);
  const webchatRepo = new WebChatRepository(db);
  await webchatRepo.recoverInterruptedInputs();
  const appRuntimeRepositories = createAppRuntimeRepositories({ settingsRepo, webchatRepo });
  const actionExecutionsRepo = new ActionExecutionsRepository(db);
  const executionJournalRepo = new ExecutionJournalRepository(db);
  const webhookInvocationsRepo = new WebhookInvocationsRepository(db);
  const routinesRepo = new RoutinesRepository(db);
  const routineRunsRepo = new RoutineRunsRepository(db);

  await ensureSentinelPersons(personMappingRepo);

  // Connection registry (use side). Descriptors are registered here at boot, but
  // the load()/import that hydrate + rebuild live connections run LATER — after
  // the message hook exists, so the first Talk unlock can attach its subscription.
  const connectionRegistry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(db) });
  const talkRouter = createTalkRouter(connectionRegistry);
  // Conferral setups: in-memory session store keyed per grant,
  // sharing the registry (descriptor lookup + terminal write) and the person
  // mapping repo (guardian-link auto-mapping). Drives the generic setup
  // routes; created here so descriptors registered later expose their setup.
  const setupManager = new SetupManager({
    registry: connectionRegistry,
    personMappingRepo,
  });
  // Descriptors are registered LATER (before registry.load(), just above the
  // Talk runtime) so their factories can be threaded the runtime
  // deps (agentLoader, mail provider, emailAdapterRef, …) that don't exist yet
  // here. All that matters is registration precedes load()/import.

  // Every Talk channel is owned by the ConnectionRegistry: each service's
  // settings row is rehydrated into the grant ledger by importChannelSettings()
  // further down; the Connection registry starts each transport. Only
  // `emailSettings` is read here, for the prompt-builder's "our own provisioned
  // inbox address" hint (the emailAdapterRef fallback below); the grant material
  // itself is imported from the same row by the settings import.
  const emailSettings = await settingsRepo.get<EmailSettings>("email");
  if (emailSettings?.enabled) {
    log.info("Loaded Email config from database");
  }

  const appsLog = createLogger("apps-domain");
  const romeCloudListings = createRomeCloudListingClient();
  const appBundleFetcher = createBundleFetcher();
  const { catalog: appCatalog, manager: appManager } = createAppDomain({
    lockfilePath: getProfileAppsLockfilePath(),
    installedRoot: getProfileInstalledAppsDir(),
    bundleFetcher: appBundleFetcher,
    romeCloudListings,
  });
  const appStore = createAppStoreService({ appCatalog });

  // Subscribers ordered agentLoader → actionLoader → skillCatalog →
  // actionRegistry → channelHook → runtimeStatus.
  const artifactIdentity = {
    legacyBindings: parseLegacyArtifactBindings(
      await settingsRepo.get(ARTIFACT_LEGACY_BINDINGS_SETTING),
    ),
  };
  const agentLoader = new AgentLoader(artifactIdentity);
  const actionLoader = new ActionLoader(artifactIdentity);
  const skillCatalog = new SkillCatalog(artifactIdentity);
  const actionRegistry = new ActionRegistryImpl(
    resolveGlobalActionNames(GLOBALLY_GRANTED_ACTIONS),
    artifactIdentity,
  );
  const favorService = new RomeCloudFavorService();

  // Each subscriber re-pulls from the catalog after every event. The event
  // is the wake signal; the catalog reads are the data source.
  appCatalog.subscribe(async function agentLoaderSubscriber() {
    try {
      await agentLoader.loadFromCatalog(appCatalog);
    } catch (err) {
      appsLog.warn("agent reload failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  appCatalog.subscribe(async function actionLoaderSubscriber() {
    try {
      await actionLoader.loadFromCatalog(appCatalog);
    } catch (err) {
      appsLog.warn("action loader reload failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  appCatalog.subscribe(async function skillCatalogSubscriber() {
    try {
      await skillCatalog.loadFromCatalog(appCatalog);
    } catch (err) {
      appsLog.warn("skill catalog reload failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  appCatalog.subscribe(async function artifactLegacyBindingsSubscriber() {
    await settingsRepo.set(ARTIFACT_LEGACY_BINDINGS_SETTING, artifactIdentity.legacyBindings);
  });
  // Migration must subscribe before appActionsSubscriber so tables exist
  // before app actions instantiate. Registering it here also covers the
  // boot path: `appManager.boot()` below fires refresh for every entry.
  appCatalog.subscribe(
    createAppDbMigrationSubscriber({
      db,
      databaseConfig: config.database,
      markBroken: (appId, code, message) => appManager.markBroken(appId, code, message),
    }),
  );
  appCatalog.subscribe(
    createRuntimeStatusSubscriber(appCatalog, {
      onError: (err) => appsLog.warn("runtime-status write failed", { error: err.message }),
    }),
  );
  // Adopts any pre-existing on-disk state (legacy deployment.yaml entries,
  // stale lockfile) into the v3 lockfile via `discardNonCurrentLockfile` and
  // `runLegacyMigrationIfNeeded`.
  try {
    const bootResult = await appManager.boot();
    appsLog.info("AppManager.boot completed", {
      appCount: bootResult.appCount,
      sweptStaging: bootResult.sweptStaging,
      brokenApps: bootResult.brokenApps,
    });
  } catch (err) {
    appsLog.error("AppManager.boot failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Install / refresh ALL first-party apps from the packed artifacts in
  // `dist/first-party-artifacts/` (`pnpm build:apps`, folded into `pnpm build`).
  // First-party apps ship with Rome: boot installs every one of them, the
  // daemon rejects uninstalling them, and enable/disable is the only user
  // control (preserved across boot reinstalls). Then assert that every app the
  // core agents reference is in that set — a core agent pointing at an unpacked
  // app must fail boot loudly, not surface later as "unknown subagent".
  const firstPartyBoot = await installFirstPartyAppsAtBoot({
    appManager,
    appCatalog,
    projectRoot: getProjectRoot(),
  });
  const coreRequiredAppIds = await deriveCoreRequiredApps({ projectRoot: getProjectRoot() });
  assertCoreRequiredAppsPacked(coreRequiredAppIds, firstPartyBoot.firstPartyAppIds);
  appsLog.info("first-party apps converged at boot", {
    firstParty: firstPartyBoot.firstPartyAppIds,
    installed: firstPartyBoot.installed,
    reinstalled: firstPartyBoot.reinstalled,
  });
  appsLog.info("artifact legacy bindings loaded", {
    agents: Object.keys(artifactIdentity.legacyBindings.agent).length,
    actions: Object.keys(artifactIdentity.legacyBindings.action).length,
    skills: Object.keys(artifactIdentity.legacyBindings.skill).length,
  });
  const sessionManager = new SessionManager(sessionsRepo, artifactIdentity);

  // Set once the email adapter is created (further down). Lets the main-agent
  // runtime context surface Rome's own provisioned inbox address, which is read
  // live when the prefix is cached on the first turn (after boot/provision).
  let emailAdapterRef: EmailAdapter | null = null;
  const promptBuilder = new PromptBuilder(
    appCatalog,
    // The provisioned inbox address lives on the live adapter (built from the
    // `inbox` grant); no settings fallback — the row carries pure config only.
    () => emailAdapterRef?.getAddress() || undefined,
    getConfiguredInstanceOrigin() ?? undefined,
  );

  // The cached system-prompt prefix bakes in app-derived context — the
  // "# Installed Apps" list (from `appCatalog.listResolved()`, which already
  // excludes disabled apps), each app's description carrying its key
  // actions/skills. That snapshot is taken on the first turn and never
  // recomputed on its own, so a runtime enable/disable/install/uninstall would
  // otherwise linger in the prompt until the next restart (e.g. a disabled app
  // staying in "# Installed Apps"). Drop the cache on every catalog change so
  // the next turn rebuilds the prefix from the current resolved set. Registered
  // after boot on purpose: the prefix isn't cached until the first turn, so the
  // boot-time refresh storm needs no invalidation.
  appCatalog.subscribe(function promptPrefixCacheInvalidator() {
    promptBuilder.invalidateAll();
  });

  const policyEngine = new PolicyEngine(policiesRepo, settingsRepo);

  const actionEngine = new ActionEngine(
    actionRegistry,
    tracer,
    actionExecutionsRepo,
    approvalsRepo,
    executionJournalRepo,
    {
      processRole: "main",
      maxWorkerProcesses: config.actionWorkerMaxProcesses,
      actionWorkerFork: (entryPath, options) => fork(entryPath, [], options),
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
  // The "openai" provider runs over the codex app-server JSON-RPC surface
  // (agentMessage `phase` → turnPhase + streaming deltas).
  const codexAppServerManager = new CodexAppServerManager();
  const codexAccountService = new SharedCodexAccountService(codexAppServerManager);
  const aiToolState = createAIToolState({
    settingsRepo,
    probes: {
      codexStatus: () => codexAccountService.getStatus(),
      codexUsage: () => codexAccountService.getUsage(),
    },
  });
  const unsubscribeCodexAccountChanged = codexAccountService.onAccountChanged(() => {
    void aiToolState.refresh("openai").catch((err) => {
      log.warn("Codex account change refresh failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  const anthropicProvider = new AnthropicProvider({
    settingsRepo,
    onAuthRevoked: () => aiToolState.markAuthRevoked("anthropic"),
    onQuotaExhausted: () => aiToolState.markQuotaExhausted("anthropic"),
  });
  const codexProvider = new CodexAppServerProvider({
    appServerManager: codexAppServerManager,
    onAuthRevoked: () => aiToolState.markAuthRevoked("openai"),
    onQuotaExhausted: () => aiToolState.markQuotaExhausted("openai"),
  });
  const modelResolver = createModelResolver({
    aiToolState,
    providers: [anthropicProvider, codexProvider],
    settingsRepo,
  });
  const conversationTitleGenerator = createConversationTitleGenerator(modelResolver);
  const lifecycleAppRuntimeServices: RomeAppRuntimeServices = {
    catalog: appCatalog,
    db,
    actionEngine,
    routinesRepo,
    repositories: appRuntimeRepositories,
    favorService,
  };
  const lifecycleDispatcher = createAgentLifecycleDispatcher({
    appRuntimeServices: lifecycleAppRuntimeServices,
  });
  const unsubscribeAIToolTurnFinished = lifecycleDispatcher.onFinished((event) => {
    // Provider failures update auth/quota state directly. Do not immediately
    // replace that stronger runtime signal with a usage probe that may lag it.
    if (event.status === "error") return;
    const provider = event.output.accounting?.provider;
    if (provider !== "openai" && provider !== "anthropic") return;
    void aiToolState.refresh(provider).catch((err) => {
      log.warn("AI tool state refresh after turn failed", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  // Turn-middleware onion. Shares the same app-runtime services as the
  // lifecycle dispatcher (the `agentRunner` field is filled in below, before
  // any hook is loaded), so a scripted-conversation middleware can summon real
  // agents and reach its own app DB.
  const turnMiddlewareChain = createTurnMiddlewareChain({
    appRuntimeServices: lifecycleAppRuntimeServices,
  });

  // Retries failed actions once after 30s.
  const routineEngine = new RoutineEngine(
    routinesRepo,
    routineRunsRepo,
    actionEngine,
    30_000,
    systemClock,
  );
  const scheduleTriggerProvider = new ScheduleTriggerProvider(routinesRepo, () =>
    resolveGuardianTimezone(settingsRepo),
  );
  routineEngine.registerProvider("schedule", scheduleTriggerProvider);

  // Registry of event types producer apps can emit; empty until a producer
  // registers, read by routine creation.
  const eventCatalog = new EventCatalog();

  // In-memory event bus (data plane): apps publish into it via the
  // `events.publish` RPC; the event-bus trigger provider reads from it.
  const eventBus = new EventBus();
  routineEngine.registerProvider("event-bus", new EventBusTriggerProvider(eventBus));

  // Manual triggers never fire on their own — they only run via runNow(). The
  // provider exists so the trigger type has a registered home (passes the API's
  // hasProvider check) and shows as active.
  routineEngine.registerProvider("manual", new ManualTriggerProvider());

  // App-facing coordinators: the single implementation each event/app-lifecycle
  // action depends on. The same instances back both the in-process action path
  // (injected into appActionDeps) and the WorkerRPC handlers, so a worker's
  // proxy and a main-process call resolve to identical behavior.
  const eventService = new EventService(eventBus, eventCatalog);
  const conversationSettings = new ConversationSettingsService({
    repository: new ConversationSettingsRepository(db),
    connections: connectionRegistry,
    listAgents: () => agentLoader.getAll().keys(),
    onChanged: async ({ ref, actor, fields, reset }) => {
      await eventService.publish({
        name: "conversation-settings.changed",
        source: "conversation-settings",
        payload: { ref, actor, fields, reset },
      });
    },
  });
  const appLifecycle = new AppLifecycleService(appManager, appCatalog, db, {
    bundleFetcher: appBundleFetcher,
  });

  // Graceful upgrades: owns the consent countdown (hub + timers, main-process
  // only) and runs the nightly probe + Rome Cloud-relayed cutover. The
  // `system_upgrade` action reaches it directly here and over WorkerRPC from a
  // worker; the API routes mount the hub for SSE status + the now/defer verbs.
  const systemUpgradeService = new SystemUpgradeService({
    countdownMs: config.systemUpgradeCountdownMinutes * 60_000,
    // Gated behind the `auto_upgrade` rollout (keyed on instance slug). Resolved
    // live on each nightly probe so a flip takes effect without a restart.
    isEnabled: () => resolveAutoUpgradeEnabled(config),
  });

  const capabilityDiscovery = new CapabilityDiscovery();
  try {
    await capabilityDiscovery.start();
  } catch (err) {
    log.warn("capability discovery failed to start (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const activeSubagentRegistry = createActiveSubagentRegistry();
  const agentTurnStreamRegistry = createAgentTurnStreamRegistry();
  const subagentExecutionService = createSubagentExecutionService({
    webchatRepo,
    activeRegistry: activeSubagentRegistry,
    turnStreams: agentTurnStreamRegistry,
  });
  const agentSessionManager = createAgentSessionManager(
    {
      agentLoader,
      appCatalog,
      sessionManager,
      promptBuilder,
      actionRegistry,
      modelResolver,
      actionEngine,
      capabilityDiscovery,
      skillCatalog,
      lifecycleDispatcher,
      webchatRepo,
      subagentExecutionService,
      activeSubagentRegistry,
      turnMiddleware: turnMiddlewareChain,
      resolveProviderSessionReset: async (ref) =>
        (await conversationSettings.get(ref)).effective.session.reset,
    },
    { keepAliveAcrossTurns: true, idleTtlMs: 15_000 },
  );
  const actionWorkerCoordinator = new ActionWorkerCoordinator(actionEngine);
  actionEngine.setActionWorkerCoordinator(actionWorkerCoordinator);
  const agentSessionBridge = new AgentSessionBridge(
    agentSessionManager,
    webchatRepo,
    actionWorkerCoordinator,
  );
  actionEngine.setAgentSessionBridge(agentSessionBridge);

  const agentRunner = new AgentRunner(
    agentSessionManager,
    agentLoader,
    webchatRepo,
    agentTurnStreamRegistry,
  );
  lifecycleAppRuntimeServices.agentRunner = agentRunner;

  const skillReviewInterval = Number(process.env.SKILL_REVIEW_INTERVAL ?? 10);
  if (skillReviewInterval > 0) {
    lifecycleDispatcher.onFinished((event) => {
      if (
        isCoreMainAgentId(event.turn.agentName) &&
        event.metrics.toolCallCount >= skillReviewInterval &&
        !event.metrics.skillWritten
      ) {
        actionEngine.run("skill_review", {}).catch((err) => {
          log.warn("skill review failed", { error: String(err) });
        });
      }
    });
  }

  // The single owner of system-initiated turns: runs a turn in a session and
  // delivers the reply to its channel (defer), and owns the webchat runtime for
  // every backend session task (approvals run their action trace + continuation
  // through it too). The webchat runtime it needs for SSE delivery is created by
  // the API layer, so it's bound after the fact (setWebchatRuntime).
  // A system-initiated continuation (defer resume, approval resume, timer) fires
  // on a fresh stack that never carried the session's project dir. Re-derive it
  // from the webchat session's project so the resumed turn runs where its SDK
  // transcript lives (stored per cwd); non-webchat threads return undefined and
  // keep the default-dir fallback. Shared by both the backend-turn orchestrator
  // and the approval handler — the two continuation entry points.
  const resolveContinuationWorkingDir = (channel: string, threadId: string) =>
    resolveWebchatContinuationWorkingDir(channel, threadId, webchatRepo);

  const backendTurnRunner = createBackendTurnRunner({
    agentRunner,
    talkRouter,
    resolveWorkingDir: resolveContinuationWorkingDir,
    conversations: appRuntimeRepositories.conversations!,
  });

  const approvalHandler = new ApprovalHandler(
    approvalsRepo,
    executionJournalRepo,
    actionEngine,
    agentRunner,
    backendTurnRunner,
    resolveContinuationWorkingDir,
  );

  // Real push sender in the main process (holds the durable instance token);
  // the worker injects NotifyServiceProxy and the WorkerRpcServer below routes
  // `notify.send` back to this same instance.
  const notifyClient = new NotifyClient();
  const resolveArtifactReference = createArtifactReferenceResolver({
    agentLoader,
    actionRegistry,
  });
  const appActionDeps = {
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
    routineEngine,
    // Real coordinators in the main process; workers inject the matching proxies
    // (see worker-runtime.ts) so the event/app-lifecycle actions are
    // process-agnostic — they never branch on where they run.
    eventBus: eventService,
    eventCatalog: eventService,
    appStore,
    appManager: appLifecycle,
    // Real service in the main process; the worker injects SystemUpgradeServiceProxy
    // so the routine-fired `system_upgrade` action reaches the same hub either way.
    systemUpgrade: systemUpgradeService,
    // Inbound email entry point. Resolved per call (the email channel can be
    // enabled at runtime) so `email_inbound` reaches the live port whether it
    // runs in the main process or a worker (where it gets the RPC proxy instead).
    emailInbound: {
      async ingest(rawBody: string, signature: string): Promise<EmailInboundResult> {
        const matches = (await talkRouter.list()).filter(
          (connection) => connection.service === "email",
        );
        if (matches.length !== 1) return { status: "skipped", reason: "channel_inactive" };
        return (await connectionRegistry.ingest(matches[0]!.connectionId, {
          rawBody,
          signature,
        })) as EmailInboundResult;
      },
    },
    actionEngine,
    actionRegistry,
    emitAgentMessage,
    resolveProfilePath: resolveProfileMemoryPath,
    strangerPersonId: STRANGER_PERSON_ID,
    // The `resume_session` action's orchestrator. Real runner in main;
    // the worker gets a BackendTurnRunnerProxy.
    backendTurnRunner,
    // Real push sender in main; the worker gets a NotifyServiceProxy.
    notify: notifyClient,
    // Image generation capability: provider-neutral registry the generate_image
    // action consumes. Codex is the only provider today; its availability reads
    // the same AiToolState the model resolver gates on.
    imageGeneration: createImageGenerationService({
      providers: [
        createCodexImageGenerationProvider({
          agentRunner,
          getCodexState: () => aiToolState.get().codex,
        }),
      ],
    }),
  };
  const appActionReload = await registerAppActions(
    actionLoader,
    actionRegistry,
    appCatalog,
    appActionDeps,
    { db, actionEngine, routinesRepo, repositories: appRuntimeRepositories, favorService },
  );

  appCatalog.subscribe(
    createAppActionsSubscriber(actionLoader, actionRegistry, appCatalog, appActionDeps, {
      db,
      actionEngine,
      routinesRepo,
      repositories: appRuntimeRepositories,
      favorService,
    }),
  );
  appCatalog.subscribe(async function favorActionRequirementsSubscriber(event) {
    await syncFavorActionRequirementsForCatalogEvent(favorService, event, actionRegistry, appsLog);
  });
  await syncFavorActionRequirementsFromCatalog(favorService, appCatalog, actionRegistry, appsLog);

  // Webhook relay drainer: hold a persistent WS to the Cloudflare relay,
  // replaying buffered webhooks into a local app handler in-process via the
  // app-api dispatcher. The stored `relay` setting is
  // the runtime source of truth; the RELAY_DRAIN_* env vars only seed it on the
  // first boot where it's absent (provisioning injection). Once set, the
  // dashboard owns it and env never overrides it. The drainer stamps
  // RELAY_DRAINED_HEADER so the target handler accepts a buffered-late delivery
  // (the public edge strips that header).
  if (config.relay && !(await settingsRepo.get(RELAY_SETTING_KEY))) {
    await settingsRepo.set(RELAY_SETTING_KEY, {
      drainUrl: sanitizeDrainUrl(config.relay.drainUrl),
      drainKey: config.relay.drainKey,
      depositUrl: deriveDepositUrl(config.relay.drainUrl),
    } satisfies RelayDrainSetting);
  }
  const relayDrains = await resolveRelayDrains(settingsRepo, appCatalog);
  const relayDispatcher = new AppApiDispatcher(appCatalog, {
    db,
    actionEngine,
    routinesRepo,
    repositories: appRuntimeRepositories,
    favorService,
  });
  const relayDrainer = new RelayDrainer(relayDrains, async (drain, event) => {
    const res = await relayDispatcher.dispatch(
      drain.targetAppId,
      buildRelayReplayRequest(drain, event),
    );
    return { status: res.status, retryAfter: res.headers.get("retry-after") };
  });

  const runtimeStatusFailures = createRuntimeStatusFailureTracker(appCatalog);
  let runtimeAppStatus = buildRuntimeStatusEntries(appCatalog);
  const refreshRuntimeAppStatus = () => {
    runtimeAppStatus = runtimeStatusFailures.entries();
    return runtimeAppStatus;
  };
  const markAppFailed = (source: string, appId: string, error: string) => {
    runtimeStatusFailures.markFailed(source, appId, error);
    refreshRuntimeAppStatus();
  };
  if (appActionReload.failed.length > 0) {
    log.warn("some app actions failed to initialize at startup", {
      failed: appActionReload.failed,
    });
    for (const failure of appActionReload.failed) {
      markAppFailed(
        `app-action:${failure.ownerId}:${failure.error}`,
        failure.ownerId,
        failure.error,
      );
    }
  }
  // App hooks discovered from the catalog share one load+report+subscribe
  // ritual: (re)load on startup, on every catalog change (install/uninstall),
  // and on an app-keys change (the reload picks up the new environment), clear
  // this kind's prior failures, surface new ones as runtime status, and
  // persist status on change. Each kind differs only in its loader and the
  // failure-source key it stamps. An empty chain is a pure passthrough.
  const registerCatalogHookLoad = async <F extends { appId: string; error: string }>(opts: {
    sourcePrefix: string;
    warnMessage: string;
    load: () => Promise<F[]>;
    failureSource: (failure: F) => string;
  }): Promise<(source: "catalog-change" | "app-keys-change") => Promise<void>> => {
    const run = async (source: "startup" | "catalog-change" | "app-keys-change") => {
      const failures = await opts.load();
      runtimeStatusFailures.clearSources((failureSource) =>
        failureSource.startsWith(`${opts.sourcePrefix}:`),
      );
      if (failures.length > 0) {
        log.warn(opts.warnMessage, { source, failures });
        for (const failure of failures) {
          markAppFailed(opts.failureSource(failure), failure.appId, failure.error);
        }
      }
      if (source !== "startup") {
        try {
          await writeAppRuntimeStatus(refreshRuntimeAppStatus());
        } catch (err) {
          log.warn(`failed to persist ${opts.sourcePrefix} runtime status`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    await run("startup");
    const subscriber = async () => {
      await run("catalog-change");
    };
    Object.defineProperty(subscriber, "name", { value: `${opts.sourcePrefix}HookSubscriber` });
    appCatalog.subscribe(subscriber);
    return run;
  };

  const reloadLifecycleHooks = await registerCatalogHookLoad({
    sourcePrefix: "lifecycle",
    warnMessage: "some agent lifecycle hooks failed to initialize",
    load: () => lifecycleDispatcher.loadFromCatalog(appCatalog),
    failureSource: (failure) => `lifecycle:${failure.hookName}:${failure.path}`,
  });

  // Turn-middleware artifacts load alongside the lifecycle hooks.
  const reloadTurnMiddlewareHooks = await registerCatalogHookLoad({
    sourcePrefix: "turn-middleware",
    warnMessage: "some turn-middleware hooks failed to initialize",
    load: () => turnMiddlewareChain.loadFromCatalog(appCatalog),
    failureSource: (failure) => `turn-middleware:${failure.path}`,
  });

  const messageHandlerRegistered = actionRegistry.has("message_handler");
  if (!messageHandlerRegistered) {
    const ownerId =
      appCatalog
        .listArtifacts("action")
        .find((artifact) => artifact.publicName === "message_handler")?.ownerId ?? "inbox";
    markAppFailed(
      "message-handler:missing",
      ownerId,
      'Required action "message_handler" is not registered',
    );
    log.warn("message_handler action is unavailable; inbound channel messages will be ignored");
  }

  // Fail-closed: every globally-granted action must resolve to a registered,
  // agent-callable action owned by the declared app now that core-required apps
  // are installed. A misconfiguration aborts startup rather than silently
  // dropping a grant every agent depends on.
  validateGlobalActions(actionRegistry, GLOBALLY_GRANTED_ACTIONS);

  // NO channel adapter is constructed here. Every Talk channel
  // (telegram, whatsapp, discord, wechat, feishu, email, telegram_user, webchat)
  // is a ConnectionDescriptor and exposes its provider-neutral Talk capability
  // through the stable router.
  //
  // Register every built-in descriptor now (before load()/import), threading the
  // runtime deps the factories need from here where the repos/adapters exist.
  const { RomeCloudMailProvider } = await import("./lib/rome-cloud-mail.js");
  registerBuiltinConnections(connectionRegistry, {
    settingsRepo,
    conversationSettings,
    personMappingRepo,
    webchatRepo,
    whatsAppSyncSink: whatsAppStoreRepo,
    linkedInSyncSink: linkedInStoreRepo,
    linkedinPoll: {
      minIntervalMs: config.linkedinPollMinMinutes * 60_000,
      maxIntervalMs: config.linkedinPollMaxMinutes * 60_000,
    },
    listAgents: () => Array.from(agentLoader.getAll().keys()),
    // Auto-map the guardian onto their own WhatsApp account on connect.
    onWhatsAppGuardianConnected: (selfJid) => {
      mapGuardianToChannel(personMappingRepo, "whatsapp", selfJid).catch((err) => {
        log.error("failed to auto-map guardian on WhatsApp connect", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    mailProvider: new RomeCloudMailProvider(),
    // Keep the prompt-builder's "our own inbox address" ref pointed at the
    // current email epoch (birth, relock/re-authorize, Disconnected rebuild).
    onEmailAdapterBuilt: (adapter) => {
      emailAdapterRef = adapter;
    },
    // The Rome Cloud-OAuth conferral setups (github/slack/google) read/write the
    // oauth_pending_attempts table for the begin-redirect + return-leg redeem.
    db,
  });

  let messageHook: ChannelMessageHook = createNoopChannelMessageHook();
  const channelMessageHookArtifact = appCatalog
    .listArtifacts("hook")
    .find((artifact) => artifact.publicName === "channel-message");
  if (messageHandlerRegistered) {
    try {
      const loadedHook = await createChannelMessageHookFromCatalog(appCatalog, {
        actionEngine,
        talkRouter,
        conversationSettings,
      });
      if (loadedHook) {
        messageHook = loadedHook;
      } else {
        log.warn("channel-message hook is unavailable; inbound channel messages will be ignored");
        if (channelMessageHookArtifact?.ownerType === "app") {
          markAppFailed(
            "channel-message:missing",
            channelMessageHookArtifact.ownerId,
            'Required hook "channel-message" is not registered',
          );
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("channel-message hook failed to initialize; using noop hook", { error });
      if (channelMessageHookArtifact?.ownerType === "app") {
        markAppFailed("channel-message:init", channelMessageHookArtifact.ownerId, error);
      }
    }
  }
  await messageHook.register();
  connectionRegistry.onUnlocked("talk", (connection) => {
    messageHook.registerConnection(connection.id, connection.service);
  });
  // App-keys refreshes recreate this hook: it is instantiated once and held by
  // the subscription closures above, so an env value captured in its module
  // graph would otherwise outlive the key edit. The let-binding is the single
  // handle — the onUnlocked callback reads it at call time, so a swap re-routes
  // future unlocks, and register() on the fresh instance re-subscribes the
  // already-unlocked connections via talkRouter.list().
  const reloadChannelMessageHook = messageHandlerRegistered
    ? createChannelMessageHookReloader({
        catalog: appCatalog,
        deps: { actionEngine, talkRouter, conversationSettings },
        getCurrent: () => messageHook,
        setCurrent: (hook) => {
          messageHook = hook;
        },
        onSkip: (reason) => log.warn(reason),
      })
    : null;

  // Fold the legacy providerAccounts rows into the grant ledger
  // BEFORE load(), so rehydration re-materializes each provider grant exactly
  // once at its final state. Must precede load() — see reconcileProviderAccounts
  // for the per-row shapes and why the single pre-load pass matters.
  await reconcileProviderAccounts(connectionRegistry.getLedger(), db, (service) =>
    connectionRegistry.isRegistered(service),
  );
  // Hydrate connection/grant state without starting provider transports. The
  // identity/settings migration must commit before any Talk epoch can observe
  // or admit messages under the new binary.
  await connectionRegistry.load({ deferCapabilities: true });
  await importChannelSettings(connectionRegistry, settingsRepo);
  cutoverConversationSettings({
    db,
    service: conversationSettings,
    listAgents: () => agentLoader.getAll().keys(),
  });
  connectionRegistry.startCapabilities();

  try {
    await writeAppRuntimeStatus(refreshRuntimeAppStatus());
  } catch (err) {
    log.warn("failed to persist app runtime status", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // The transport lifecycle is entirely registry-owned: every channel is a
  // ConnectionDescriptor whose Talker the registry starts on unlock. No
  // adapter-level start() loop exists.

  if (relayDrains.length > 0) {
    relayDrainer.start();
    for (const drain of relayDrains) {
      log.info("relay drainer started", {
        target: `${drain.targetAppId}/${drain.targetPath.join("/")}`,
      });
    }
  }

  // Keep the live drainer pointed at the catalog-resolved target. AppCatalog
  // hot-swaps installed/enabled apps at runtime, so installing, disabling, or
  // upgrading the app that declares api.relayWebhook changes which app/path the
  // drain resolves to. Without this the drainer would keep replaying to the old
  // target (or loop on 5xx after the consumer disappears) until a manual save.
  let activeRelayDrains = relayDrains;
  appCatalog.subscribe(async function relayDrainSubscriber() {
    const next = await resolveRelayDrains(settingsRepo, appCatalog);
    if (relayDrainsEqual(activeRelayDrains, next)) return;
    activeRelayDrains = next;
    await relayDrainer.reload(next);
    log.info("relay drains reloaded after catalog change", {
      targets: next.map((d) => `${d.targetAppId}/${d.targetPath.join("/")}`),
    });
  });

  const workerRpcServer = new WorkerRpcServer({
    talkRouter,
    connectionRegistry,
    conversationSettings,
    routinesRepo,
    routineEngine,
    eventService,
    appLifecycle,
    appStore,
    systemUpgrade: systemUpgradeService,
    hasAgent: (name) => agentLoader.has(name),
    hasRegisteredAction: (name) => actionRegistry.has(name),
    // Resolve capability through the same allow-list path the agent session
    // uses (`getForAgent` honors the agent's `actions`, `*`, and globally
    // granted actions), so the inbox channel-control cue can't disagree with
    // what the routed agent is actually allowed to call. Unknown agent → false.
    hasAction: (agentName, actionName) => {
      let config;
      try {
        const record = agentLoader.getRecord(agentName);
        config = record.config;
      } catch {
        return false;
      }
      return actionRegistry
        .getForAgent(config.actions ?? [])
        .some((action) => action.config.name === actionName);
    },
    backendTurnRunner,
    notify: notifyClient,
  });
  actionEngine.setWorkerRpcServer(workerRpcServer);
  actionEngine.startWorkerWarmPool();
  // Fallback for worker→main RPC issued from action bodies that run in the main
  // process (no parent IPC channel) — e.g. an agent turn proxied back to main
  // whose tool calls execute in-process. Without this, those calls throw
  // "WorkerRPC: not running in a Node.js child process".
  setWorkerRpcInProcessDispatcher((method, params) =>
    workerRpcServer.dispatchInProcess(method, params),
  );
  appCatalog.subscribe(async function actionWorkerWarmPoolInvalidator() {
    await actionEngine.restartWorkerWarmPool();
  });
  // An app-keys change edits process.env after app code may have captured it:
  // warm workers hold a fork-time env snapshot, and main-process app modules
  // (API handlers via AppApiDispatcher, hook chains) can read env at module
  // scope and stay cached — the import cache key is file identity, which an
  // env change never touches. Salt the cache (so every later import
  // re-evaluates), recycle the workers, and reload the hook chains, in that
  // order — a reload before the bump would reinstall the stale modules.
  const refreshAppRuntimeEnv = async (): Promise<void> => {
    bumpModuleEnvEpoch();
    await actionEngine.restartWorkerWarmPool();
    await reloadLifecycleHooks("app-keys-change");
    await reloadTurnMiddlewareHooks("app-keys-change");
    if (reloadChannelMessageHook) {
      try {
        await reloadChannelMessageHook();
      } catch (err) {
        log.warn("channel-message hook reload failed; keeping the previous instance", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const publicAccessState = new PublicAccessState();
  try {
    await publicAccessState.load(db);
  } catch (err) {
    log.warn("Failed to load publicAccess settings; starting with empty allow-list", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const dashboardAccessState = new DashboardAccessState();
  try {
    await dashboardAccessState.load(db);
  } catch (err) {
    log.warn("Failed to load dashboardAccess settings; starting with empty allow-list", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Learn whether this boot's release version differs from the last completed
  // boot's — the dashboard reads the result via /api/build-info. The stored
  // version is committed after "Rome started" below.
  const bootVersionReport = await reportBootVersion(settingsRepo, getBuildInfo());

  // Wire the process-global feature-flag backend (Statsig) when a server secret
  // is configured, then apply any FEATURE_GATE_* env overrides on top, then
  // expose a live cloud-auth resolver rather than a boot-time snapshot. The
  // login routes re-evaluate it on each sign-in entry (`/login`'s bootstrap), so
  // flipping the gate takes effect without restarting — the backend
  // background-polls its rule set.
  //
  // The Statsig import is dynamic and tolerant of failure so a broken native
  // binding fails closed to local auth instead of crashing boot. The env
  // overrides are applied afterwards so they win over the backend (and work with
  // no Statsig wired at all — the break-glass / local-dev knob).
  let shutdownFeatureFlags: (() => Promise<void>) | undefined;
  if (config.statsigServerSecretKey) {
    try {
      const { initStatsig } = await import("@rome-os/libs/feature-flags/statsig");
      shutdownFeatureFlags = initStatsig(
        config.statsigServerSecretKey,
        createLogger("feature-flags"),
      );
    } catch (err) {
      log.warn("feature-flag backend init failed; gates fail closed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const { installEnvGateOverrides } = await import("@rome-os/libs/feature-flags/env-overrides");
  const gateOverrides = installEnvGateOverrides(process.env);
  const isCloudAuthEnabled = () => resolveCloudAuthEnabled(config, db);
  log.info("Cloud-auth gating configured", {
    slug: config.instanceSlug ?? null,
    gateConfigured: shutdownFeatureFlags !== undefined,
    gateOverrides,
  });

  let internalApi: ApiHandle | undefined;
  try {
    const apiDeps: ApiDeps = {
      talkRouter,
      conversationSettings,
      actionEngine,
      actionLoader,
      personMappingRepo,
      whatsAppStoreRepo,
      channels,
      accountNames,
      webchatRepo,
      webhookInvocationsRepo,
      approvalsRepo,
      approvalHandler,
      backendTurnRunner,
      routineEngine,
      eventCatalog,
      routinesRepo,
      routineRunsRepo,
      appCatalog,
      appManager,
      romeCloudListings,
      appStore,
      actionRegistry,
      agentLoader,
      skillCatalog,
      db,
      settingsRepo,
      appKeysRepo,
      appKeyInjector,
      refreshAppRuntime: refreshAppRuntimeEnv,
      appRuntimeRepositories,
      sentinelLogRepo,
      actionExecutionsRepo,
      sessionManager,
      agentSessionManager,
      conversationTitleGenerator,
      agentRunner,
      activeSubagentRegistry,
      agentTurnStreamRegistry,
      aiToolState,
      codexAccountService,
      publicAccessState,
      dashboardAccessState,
      relayDrainer,
      bootVersionReport,
      favorService,
      systemUpgradeService,
      isCloudAuthEnabled,
      connectionRegistry,
      setupManager,
    };
    internalApi = await startApi(config.internalApi, apiDeps);
  } catch (err) {
    log.warn("Failed to start internal API", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const favorDispatchRunner = new FavorDispatchRunner({
    favorService,
    actionEngine,
    canSync: () => getInstanceToken() !== null,
  });

  // Drains the deprecated events table into routines (one-shot, idempotent).
  // Runs before the engine starts so migrated routines get activated, and
  // before the sentinel_review bootstrap so a migrated sentinel routine
  // suppresses a duplicate.
  try {
    await migrateEventsToRoutines({ db, routinesRepo, settingsRepo });
  } catch (err) {
    log.error("events→routines migration failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  await routineEngine.start();

  favorDispatchRunner.start();

  const intervalMinutes = config.sentinelReviewIntervalMinutes;
  // Match across all routines, not just enabled ones: a disabled sentinel_review
  // (e.g. paused by an operator) must not spawn a duplicate on the next boot.
  const existingRoutines = await routinesRepo.findAll();
  const hasSentinelReview = existingRoutines.some((r) => r.actionName === "sentinel_review");

  if (!hasSentinelReview) {
    try {
      const result = await actionEngine.run(
        "create_routine",
        {
          name: "sentinel_review",
          trigger: {
            type: "schedule",
            tzid: "UTC",
            localTime: "00:00",
            rrule:
              intervalMinutes < 60
                ? `FREQ=MINUTELY;INTERVAL=${intervalMinutes}`
                : `FREQ=HOURLY;INTERVAL=${Math.round(intervalMinutes / 60)}`,
          },
          actionName: "sentinel_review",
          args: {},
        },
        { initiator: "startup:system-events" },
      );
      if (result.status === "error") {
        throw new Error(result.error);
      }
      if (result.status === "pending_approval") {
        throw new Error('Action "create_routine" unexpectedly requested approval');
      }
      log.info("sentinel review scheduled", { intervalMinutes });
    } catch (err) {
      log.warn("failed to schedule sentinel_review", { error: err });
    }
  }

  // Rome reserves 3:00–3:30am local for upgrades; the probe runs at the start
  // of that window. There is no bespoke scheduler — the routine cron *is* the
  // placement. The trigger is `floating`: 3am means 3am in the
  // guardian's *current* timezone, re-resolved on every boot and whenever they
  // change it — so the upgrade window follows the guardian rather than freezing
  // the host zone at first boot. The seed `tzid` is the zone at creation; the
  // scheduler ignores it for floating and uses the live guardian zone.
  // Idempotent: a disabled routine still suppresses a duplicate on the next boot.
  const hasSystemUpgrade = existingRoutines.some((r) => r.actionName === "system_upgrade");
  if (!hasSystemUpgrade) {
    const tzid = await resolveGuardianTimezone(settingsRepo);
    try {
      const result = await actionEngine.run(
        "create_routine",
        {
          name: "system_upgrade",
          trigger: {
            type: "schedule",
            tzid,
            tzMode: "floating",
            localTime: "03:00",
            rrule: "FREQ=DAILY",
          },
          actionName: "system_upgrade",
          args: {},
        },
        { initiator: "startup:system-events" },
      );
      if (result.status === "error") {
        throw new Error(result.error);
      }
      if (result.status === "pending_approval") {
        throw new Error('Action "create_routine" unexpectedly requested approval');
      }
      log.info("system upgrade probe scheduled daily at 03:00", { tzid });
    } catch (err) {
      log.warn("failed to schedule system_upgrade", { error: err });
    }
  }
  const journalCleanupLog = createLogger("journal-cleanup");

  async function runJournalCleanup() {
    try {
      const retentionDays = (await settingsRepo.get<number>("journalRetentionDays")) ?? 7;
      const cutoff = new Date(Date.now() - retentionDays * 86400000);
      const activeIds = await approvalsRepo.findActiveRootExecutionIds();
      await executionJournalRepo.deleteOlderThan(cutoff, activeIds);
      journalCleanupLog.info("journal cleanup completed", {
        retentionDays,
        excludedActiveIds: activeIds.length,
      });
    } catch (err) {
      journalCleanupLog.error("journal cleanup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await runJournalCleanup();
  const journalCleanupInterval = setInterval(runJournalCleanup, 6 * 3600000);

  const activeChannels = [
    ...new Set((await talkRouter.list()).map((connection) => connection.service)),
  ];
  const allRoutines = await routinesRepo.findEnabled();
  const agentNames = Array.from(agentLoader.getAll().keys());
  const discoveredServers = Object.keys(capabilityDiscovery.getCdpMcpServers());
  const appIds = appCatalog.listResolved().map((app: ResolvedApp) => app.appId);
  const actionOwners = actionRegistry.list().map((name) => {
    const metadata = actionRegistry.getMetadata(name);
    return metadata ? `${name}:${metadata.ownerType === "app" ? metadata.ownerId : "core"}` : name;
  });
  const agentOwners = Array.from(agentLoader.getAllRecords().entries()).map(
    ([name, record]) =>
      `${name}:${record.metadata.ownerType === "app" ? record.metadata.ownerId : "core"}`,
  );
  log.info("Rome started", {
    apps: appIds.length > 0 ? appIds : ["none"],
    channels: activeChannels.length > 0 ? activeChannels : ["none"],
    agents: agentNames,
    agentOwners,
    actions: actionOwners,
    appActionsLoaded: appActionReload.loaded.length > 0 ? appActionReload.loaded : ["none"],
    appActionFailures: appActionReload.failed,
    routines: allRoutines.length,
    sentinelReviewIntervalMinutes: config.sentinelReviewIntervalMinutes,
    discoveredCdpServers: discoveredServers.length > 0 ? discoveredServers : ["none"],
  });

  // Startup is known-good: record this version as the last completed boot so
  // the next boot's upgrade comparison runs against it.
  await commitBootVersion(settingsRepo, getBuildInfo());

  // Best-effort instance-identity check. Fire-and-forget: announces
  // which account this instance is bound to, reports the running version, and
  // bumps the server's lastSeen without ever blocking or failing boot. The same
  // prove result records the bound account onto the guardian seat — no second
  // prove.
  void logInstanceIdentityAtBoot(getBuildInfo().version).then((identity) =>
    recordResolvedAccount(db, identity),
  );

  // Beyond the boot-time prove, re-verify the instance token every 15 minutes so
  // a mid-session revocation is noticed within one interval. On a terminal
  // signal it clears the credential (DB + cache), which flips the instance back
  // to "not enrolled" and routes the dashboard to the connect flow.
  const stopInstanceHeartbeat = startInstanceIdentityHeartbeat({ store: settingsRepo });

  // Self-provision the webhook-relay mailbox using the durable instance token
  //: present it to Rome Cloud, store the returned credential, and point
  // the live drainer at it. Fire-and-forget and idempotent — it re-mints a
  // full-TTL drain key on every boot, and no-ops when the instance is not
  // enrolled (leaving any manually-pasted relay setting untouched).
  void provisionRelayMailboxAtBoot({ settingsRepo, appCatalog, relayDrainer });

  process.on("unhandledRejection", (reason) => {
    const shutdownLog = createLogger("shutdown");
    shutdownLog.error("unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    // Flush the ERROR record to ClickStack (bounded) before exiting; a raw
    // `process.exit(1)` here discards the BatchLogRecordProcessor's queue.
    void flushTelemetryThenExit(1);
  });

  process.on("uncaughtException", (err) => {
    const shutdownLog = createLogger("shutdown");
    shutdownLog.error("uncaught exception", {
      error: err.message,
      stack: err.stack,
    });
    void flushTelemetryThenExit(1);
  });

  let shuttingDown = false;

  async function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    const shutdownLog = createLogger("shutdown");
    shutdownLog.info("shutting down", { signal });

    if (internalApi) {
      try {
        await internalApi.close();
        shutdownLog.info("internal API stopped");
      } catch (err) {
        shutdownLog.error("error stopping internal API", { error: err });
      }
    }

    try {
      await connectionRegistry.stopAll();
      shutdownLog.info("connection registry stopped");
    } catch (err) {
      shutdownLog.error("error stopping connection registry", { error: err });
    }

    try {
      await relayDrainer.stop();
      shutdownLog.info("relay drainer stopped");
    } catch (err) {
      shutdownLog.error("error stopping relay drainer", { error: err });
    }

    stopInstanceHeartbeat();
    shutdownLog.info("instance identity heartbeat stopped");

    capabilityDiscovery.stop();
    shutdownLog.info("capability discovery stopped");

    unsubscribeAIToolTurnFinished();
    unsubscribeCodexAccountChanged();
    codexAccountService.close();
    shutdownLog.info("Codex account service stopped");

    aiToolState.close();
    shutdownLog.info("AI tool state stopped");

    codexProvider.close();
    shutdownLog.info("Codex app-server stopped");

    clearInterval(journalCleanupInterval);
    shutdownLog.info("journal cleanup timer stopped");

    favorDispatchRunner.stop();
    shutdownLog.info("favor dispatch runner stopped");

    routineEngine.stop();
    shutdownLog.info("routine engine stopped");

    const delegatedCancelled = actionWorkerCoordinator.cancelAll();
    shutdownLog.info("delegated action workers cancellation requested", {
      count: delegatedCancelled,
    });

    await actionEngine.stopWorkerWarmPool();
    shutdownLog.info("action worker warm pool stopped");

    if (shutdownFeatureFlags) {
      await shutdownFeatureFlags();
      shutdownLog.info("feature-flag backend stopped");
    }

    await shutdownTelemetry();
    shutdownLog.info("telemetry shut down");

    process.exit(0);
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

main().catch((err) => {
  // Boot-time telemetry is initialized early in `main()`, so a fatal boot error
  // reaches ClickStack via `createLogger` here. Flush is bounded so a down
  // collector can't wedge the failed boot.
  log.error("Failed to start Rome", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  void flushTelemetryThenExit(1);
});
