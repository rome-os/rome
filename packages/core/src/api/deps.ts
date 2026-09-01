import type { ActionEngine } from "../actions/engine.js";
import type { ActionLoader } from "../actions/loader.js";
import type { DrizzleDb } from "../db/index.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { WhatsAppStoreRepository } from "../db/repositories/whatsapp-store.js";
import type { Channels } from "../channels/channel.js";
import type { AccountNames } from "../channels/account-names.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { WebhookInvocationsRepository } from "../db/repositories/webhook-invocations.js";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { ApprovalHandler } from "../actions/approval-handler.js";
import type { MainBackendTurnRunner } from "../actions/backend-turn.js";
import type { RoutineEngine } from "../routines/engine.js";
import type { EventCatalog } from "../event-catalog.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { AppManager } from "../apps/manager.js";
import type { RomeCloudListingClient } from "../apps/rome-cloud-listing-client.js";
import type { AppStoreReader } from "../apps/store-service.js";
import type { ActionRegistryImpl } from "../actions/registry.js";
import type { AgentLoader } from "../core/agent-loader.js";
import type { SkillCatalog } from "../core/skill-catalog.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { AppKeysRepository } from "../db/repositories/app-keys.js";
import type { AppKeyInjector } from "../app-keys/injector.js";
import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import type { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import type { SessionManager } from "../core/session-manager.js";
import type { AgentSessionManager } from "../core/agent-session.js";
import type { ActiveSubagentRegistry } from "../core/active-subagent-registry.js";
import type { AgentTurnStreamRegistry } from "../core/agent-turn-stream-registry.js";
import type { AIToolState } from "../core/ai-tool-state.js";
import type { CodexAccountService } from "../core/codex/account-service.js";
import type { PublicAccessState } from "../lib/public-access-state.js";
import type { DashboardAccessState } from "../lib/dashboard-access-state.js";
import type { RelayDrainer } from "../relay/drainer.js";
import type { BootVersionReport } from "../lib/boot-version-report.js";
import type { SystemUpgradeService } from "../system-upgrade/service.js";
import type {
  AppRuntimeRepositories,
  ConversationSettingsControl,
  TalkRouter,
} from "@rome-os/app-runtime";
import type { FavorService } from "../favors/types.js";
import type { ConnectionRegistry } from "../connections/index.js";
import type { SetupManager } from "../connections/setup/manager.js";
import type { AgentRunnerInterface } from "../core/types.js";
import type { ConversationTitleGenerator } from "../core/conversation-title.js";

export interface ApiConfig {
  port: number;
  host: string;
  webhookApiKey?: string;
  /** Absolute path to the built SPA (Vite `dist/`). When set, the server
   * serves the SPA shell for non-API routes — needed for loopback callers
   * inside the container (`localhost:4141/dashboard`, headless browsers,
   * etc.) and also handles public traffic that arrives via Caddy. */
  webRoot?: string;
}

/**
 * Every field is required: the daemon (`src/index.ts`, the sole production
 * caller of `startApi`) unconditionally constructs all of them. Tests supply
 * the full set via `buildTestDeps()` in `src/test/helpers.ts`. The one
 * exception is `appsRoot`, a genuine config override rather than a service.
 */
export interface ApiDeps {
  talkRouter: TalkRouter;
  conversationSettings: ConversationSettingsControl;
  actionEngine: ActionEngine;
  actionLoader: Pick<ActionLoader, "get">;
  db: DrizzleDb;
  personMappingRepo: PersonMappingRepository;
  /** Durable mirror of the WhatsApp address book + message history (People tab). */
  whatsAppStoreRepo: WhatsAppStoreRepository;
  /** Every channel Rome reads, each carrying its address book and what was said
   *  on it. LinkedIn reaches the API only through here — no route reads its
   *  store directly. */
  channels: Channels;
  /** What each platform calls an account, over every address book Rome mirrors
   *  and the names senders put on their own messages — the display name a
   *  person or account serializer puts on the wire. */
  accountNames: AccountNames;
  webchatRepo: WebChatRepository;
  webhookInvocationsRepo: WebhookInvocationsRepository;
  approvalsRepo: ApprovalsRepository;
  approvalHandler: ApprovalHandler;
  /** Main-process backend-turn orchestrator. The webchat runtime it
   * needs for SSE delivery is bound inside `buildApp` once `createWebchatRuntime`
   * has produced it. */
  backendTurnRunner: MainBackendTurnRunner;
  routineEngine: RoutineEngine;
  /** Registry of event types producer apps can currently emit.
   * Read by routine creation to populate the event-bus trigger picker. */
  eventCatalog: EventCatalog;
  routinesRepo: RoutinesRepository;
  routineRunsRepo: RoutineRunsRepository;
  /** AppCatalog — sole read surface for app artifacts. */
  appCatalog: AppCatalog;
  /** AppManager — sole writer for install/uninstall/setEnabled. */
  appManager: AppManager;
  romeCloudListings: RomeCloudListingClient;
  /** Rome App Store read surface used by the dashboard and agent-facing actions. */
  appStore: AppStoreReader;
  actionRegistry: ActionRegistryImpl;
  agentLoader: AgentLoader;
  /** Live skill catalog — read by `GET /api/skills` for the Skills app and
   * the chat composer's slash-command autocomplete. `getRegistryLoadFailures`
   * surfaces app-owned skills that were declared but failed to load, so the
   * Skills app can show an author *why* a skill is missing. */
  skillCatalog: Pick<SkillCatalog, "get" | "getAll" | "getRegistryLoadFailures">;
  /** Override for `~/.rome/<profile>/apps/` (tests inject tmpdir). */
  appsRoot?: string;
  settingsRepo: SettingsRepository;
  appKeysRepo: AppKeysRepository;
  appKeyInjector: AppKeyInjector;
  /** Makes an app-keys environment change reach already-running app code:
   * salts the module-import cache, recycles warm action workers, and reloads
   * the hook chains. See `refreshAppRuntimeEnv` in `src/index.ts`. */
  refreshAppRuntime: () => Promise<void>;
  appRuntimeRepositories: AppRuntimeRepositories;
  sentinelLogRepo: SentinelLogRepository;
  actionExecutionsRepo: ActionExecutionsRepository;
  sessionManager: SessionManager;
  agentSessionManager: AgentSessionManager;
  /** Lightweight, tool-free small-model request used to name a new chat. */
  conversationTitleGenerator: ConversationTitleGenerator;
  /** Live agent runner used by API-owned background turns such as explicit
   * turn-feedback processing. */
  agentRunner: AgentRunnerInterface;
  activeSubagentRegistry: ActiveSubagentRegistry;
  agentTurnStreamRegistry: AgentTurnStreamRegistry;
  aiToolState: AIToolState;
  /** Process-global Codex auth/usage operations on the shared app-server. */
  codexAccountService: CodexAccountService;
  /**
   * In-memory snapshot of app access policy, read by `/api/auth/verify` on
   * every proxied request. Kept in sync by the `/api/public-access` PUT handler.
   */
  publicAccessState: PublicAccessState;
  /**
   * In-memory snapshot of shared dashboard access policy, read by
   * `/api/auth/verify` on every proxied request. Kept in sync by
   * `/api/dashboard-access`.
   */
  dashboardAccessState: DashboardAccessState;
  /** Webhook relay drainer — present so the Integrations settings route can
   * hot-reload the live connection when the guardian edits relay credentials. */
  relayDrainer: RelayDrainer;
  /** Boot-time comparison of the running release version against the one the
   * previous boot recorded — surfaced via `GET /api/build-info` so the
   * dashboard can show an "upgraded since last boot" notice. */
  bootVersionReport: BootVersionReport;
  /** Rome Cloud-backed favor ledger/request service. */
  favorService: FavorService;
  /** Owns the upgrade consent countdown (UpgradeStatusHub) behind
   * `GET /api/system/upgrade/status/snapshot` and the `/now` `/defer` verbs,
   * and runs the nightly probe + Rome Cloud-relayed cutover. */
  systemUpgradeService: SystemUpgradeService;
  /** Live cloud-auth decision, re-evaluated per call via `resolveCloudAuthEnabled`
   * (the `rome_cloud_auth` Statsig rollout gate). The login-flow
   * routes call this on each sign-in entry — the bootstrap phase
   * (`GET /api/bootstrap` behind `/login`) and the cloud-login start/callback —
   * so flipping the gate takes effect without restarting the instance. */
  isCloudAuthEnabled: () => Promise<boolean>;
  /** Use-side registry. Present but with zero registered descriptors in
   *  this phase — later phases register real integrations and route through it. */
  connectionRegistry?: ConnectionRegistry;
  /** Conferral-setup sessions. In-memory, created alongside the
   *  registry; drives the generic setup routes. Present only when the
   *  registry is. */
  setupManager?: SetupManager;
}

export interface ApiHandle {
  port: number;
  close(): Promise<void>;
}
