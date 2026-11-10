import type { AgentNameEvents } from "../people/agent-name.js";
import type { GuardianLinkCodes } from "../people/guardian-link-code.js";
import type { SessionOpeningFor } from "../core/session-opening.js";
import type { LoginUsageSink } from "../usage/recorder.js";
import type { CloudProfileService } from "../instance/cloud-profile.js";
import type { createNodeDevicesService } from "../desktops/node-devices.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import type { ConciergeService } from "../concierge/service.js";
import type { ActionLoader } from "../apps/actions/loader.js";
import type { DrizzleDb } from "../db/index.js";
import type { AppConnectionAccessRepository } from "../connections/app-connection-access.js";
import type { PeopleRepository } from "../db/repositories/people.js";
import type {
  Channels,
  PlatformOfChannel,
  RecordedOn,
} from "../chats/connected-accounts/connected-account.js";
import type { SendRecording } from "../connections/send.js";
import type { ChatRepository } from "../chats/storage/chat-repository.js";
import type { MessageRepository as ChatLines } from "../chats/storage/message-repository.js";
import type { ChannelRecordsRepository, SendersOn } from "../db/repositories/channel-records.js";
import type { AccountNames } from "../chats/accounts/account-names.js";
import type { ExternalAgents } from "../chats/accounts/agents-accounts.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { WebhookInvocationsRepository } from "../apps/repositories/webhook-invocations.js";
import type { ApprovalsRepository } from "../apps/repositories/approvals.js";
import type { ApprovalHandler } from "../apps/actions/approval-handler.js";
import type { MainBackendTurnRunner } from "../apps/actions/backend-turn.js";
import type { RoutineEngine } from "../routines/engine.js";
import type { EventCatalog } from "../event-catalog.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import type { ArtifactLoadFailureSource } from "../apps/artifact-load-failure-reporter.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { OgImageStore } from "../apps/og/store.js";
import type { AppManager } from "../apps/manager.js";
import type { RomeCloudListingClient } from "../apps/rome-cloud-listing-client.js";
import type { AppStoreReader } from "../apps/store-service.js";
import type { ActionRegistryImpl } from "../apps/actions/registry.js";
import type { Agent, AgentCatalog } from "../agent/index.js";
import type { AgentLoader } from "../apps/agent-loader.js";
import type { SkillCatalog, SubagentCalls } from "../agent/index.js";
import type { FeedbackRelay } from "../lib/feedback-client.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { AppKeysRepository } from "../apps/repositories/app-keys.js";
import type { AppKeyInjector } from "../apps/app-keys/injector.js";
import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import type { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import type { SessionRepository } from "../agent/index.js";
import type { Sessions } from "../agent/index.js";
import type { AgentTurnStreamRegistry } from "../core/agent-turn-stream-registry.js";
import type { Hono } from "hono";
import type { ClaudeLogins, CodexLogins, ModelAccount, ModelAccounts } from "../agent/index.js";
import type { Permissions } from "../access/permissions.js";
import type { DashboardAccessState } from "../access/dashboard-access-state.js";
import type { DashboardAccessStore } from "../access/dashboard-access-store.js";
import type { VisitorAllowListSync } from "../access/visitor-allowlist-sync.js";
import type { PhoneWatching } from "../lib/phone-watching.js";
import type { DashboardActivity } from "../lib/dashboard-activity.js";
import type { RelayDrainer } from "../relay/drainer.js";
import type { BootVersionReport } from "../instance/boot-version-report.js";
import type { SystemUpgradeService } from "../instance/system-upgrade/service.js";
import type {
  AppRuntimeRepositories,
  ChatSettingsControl,
  ChannelsService,
} from "@rome-os/app-runtime";
import type { FavorService } from "../favors/index.js";
import type { ConnectionRegistry } from "../connections/index.js";
import type { AccountListening } from "../chats/connected-accounts/account-agents.js";
import type { SetupManager } from "../connections/setup/manager.js";
import type { AgentRunnerInterface } from "../core/types.js";
import type { ConversationTitleGenerator } from "../core/conversation-title.js";
import type { ComputerUseService } from "../desktops/computer-use.js";
import type { WechatApp } from "../connections/kinds/wechat-user/wechat-app.js";
import type { AppConnectionsContextFactory } from "../connections/app-connections.js";

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
  agentNameEvents?: AgentNameEvents;
  /** The Concierge feature. Absent ⇒ its routes answer 404. */
  concierge?: ConciergeService;
  /** The channels this Rome has, by name. */
  channelsService: ChannelsService;
  chatSettings: ChatSettingsControl;
  actionEngine: ActionEngine;
  actionLoader: Pick<ActionLoader, "get" | "getRegistryLoadFailures">;
  db: DrizzleDb;
  /** Shared with App lifecycle handling so access writes serialize with disable and removal. */
  appConnectionAccessRepo: AppConnectionAccessRepository;
  peopleRepo: PeopleRepository;
  /** The guardian's link code, shown in People (people/guardian-link-code.ts). */
  guardianLinkCodes: GuardianLinkCodes;
  /** Every channel Rome reads, each carrying its address book and what was said
   *  on it. WhatsApp and LinkedIn reach the API only through here — no route
   *  reads either store directly. */
  channels: Channels;
  /** The platform a channel's accounts live on, for a row that still names a
   *  channel, such as a message store's. */
  platformOfChannel: PlatformOfChannel;
  /** Every channel recorded on a platform, released ones included: where a
   *  history told to a disconnected account is still stored. */
  recordedOn: RecordedOn;
  /** The channels of Rome's accounts on a platform a send may go out from. */
  sendersOn: SendersOn;
  /** Rome's own account on a channel, which a send names as `from`. */
  accountOf: ChannelRecordsRepository["accountOf"];
  /** What each platform calls an account, over every address book Rome mirrors
   *  and the names senders put on their own messages — the display name a
   *  person or account serializer puts on the wire. */
  accountNames: AccountNames;
  /** The agents Rome Cloud lists for this Rome. Each is an assistant with one
   *  chat (docs/domains/chats.md#assistant), and the dashboard shows all but
   *  other Romes. */
  assistants: ExternalAgents;
  webchatRepo: WebChatRepository;
  /** Where a send into a place is said and put on record in Chats. */
  recording: SendRecording;
  /** The chats Rome takes part in, by their adapter's keys. */
  chats: Pick<ChatRepository, "byKey">;
  /** What was said in each chat, as Chats records it. */
  messages: Pick<ChatLines, "read">;
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
  /** The agents under every name they have had, for reading names stored before ids were canonical. */
  agentsByName: () => ReadonlyMap<string, Agent>;
  /** Social card PNGs rendered by apps/og/subscriber.ts. */
  ogImageStore: OgImageStore;
  /** AppManager — sole writer for install/uninstall/setEnabled. */
  appManager: AppManager;
  romeCloudListings: RomeCloudListingClient;
  /** Rome App Store read surface used by the dashboard and agent-facing actions. */
  appStore: AppStoreReader;
  actionRegistry: ActionRegistryImpl;
  agentLoader: AgentCatalog & Pick<AgentLoader, "getRegistryLoadFailures">;
  /** Told of each write to an account's agent, so the account's inbound port
   *  starts or stops listening. */
  accountListening: Pick<AccountListening, "changed">;
  /** Live skill catalog — read by `GET /api/skills` for the Skills app and
   * the chat composer's slash-command autocomplete. `getRegistryLoadFailures`
   * surfaces app-owned skills that were declared but failed to load, so the
   * Skills app can show an author *why* a skill is missing. */
  skillCatalog: SkillCatalog & ArtifactLoadFailureSource;
  /** Override for `~/.rome/<profile>/apps/` (tests inject tmpdir). */
  appsRoot?: string;
  settingsRepo: SettingsRepository;
  feedback: FeedbackRelay;
  nodeDevices: Pick<
    ReturnType<typeof createNodeDevicesService>,
    "getStatus" | "start" | "listFiles" | "listDevices" | "renameDevice" | "removeDevice"
  >;
  /** Starts what needs a linked instance: node caller, relay mailbox, favor sync. Never rejects. */
  provisionAfterLink?: () => Promise<void>;
  /** The guardian's Rome Cloud account, whose signup survey a first sign-in reads. */
  cloudProfile?: CloudProfileService;
  /** Connects the Rome Cloud email inbox unless an email connection exists.
   *  Never rejects. */
  autoConnectEmail?: () => Promise<void>;
  computerUse: Pick<ComputerUseService, "getStatus">;
  /** The WeChat app on WeChat's own desktop. Null while WeChat is disabled. */
  wechatApp: Pick<WechatApp, "status" | "install" | "start"> | null;
  appKeysRepo: AppKeysRepository;
  appKeyInjector: AppKeyInjector;
  /** Makes an app-keys environment change reach already-running app code:
   * salts the module-import cache, recycles warm action workers, and reloads
   * the hook chains. See `refreshAppRuntimeEnv` in `src/index.ts`. */
  refreshAppRuntime: () => Promise<void>;
  appRuntimeRepositories: AppRuntimeRepositories;
  appConnections?: AppConnectionsContextFactory;
  sentinelLogRepo: SentinelLogRepository;
  actionExecutionsRepo: ActionExecutionsRepository;
  sessionRepository: SessionRepository;
  agentSessionManager: Sessions;
  /** What a route states for a session it opens. */
  sessionOpeningFor: SessionOpeningFor;
  /** Lightweight, tool-free small-model request used to name a new chat. */
  conversationTitleGenerator: ConversationTitleGenerator;
  /** Live agent runner used by API-owned background turns such as explicit
   * turn-feedback processing. */
  agentRunner: AgentRunnerInterface;
  subagentCalls: SubagentCalls;
  agentTurnStreamRegistry: AgentTurnStreamRegistry;
  /** Whether a run can use each model provider now, from the accounts' own reports. */
  modelAccounts: ModelAccounts;
  /** The guardian's Codex account, served by the shared app-server. */
  codexAccountService: ModelAccount & CodexLogins;
  /** The guardian's Claude account, read from the Claude CLI and Rome's stored credentials. */
  claudeAccount: ModelAccount & ClaudeLogins;
  /** Codex's loopback route to Rome credits, built by the composition root. */
  romeCreditsProxy: Hono;
  /**
   * In-memory snapshot of app access policy, read by `/api/auth/verify` on
   * every proxied request. Kept in sync by the `/api/public-access` PUT handler.
   */
  permissions: Permissions;
  /**
   * In-memory snapshot of shared dashboard access policy, read by
   * `/api/auth/verify` on every proxied request. Kept in sync by
   * `/api/dashboard-access`.
   */
  dashboardAccessState: DashboardAccessState;
  /** The stored dashboard allow-list and the revision Rome Cloud orders it by. */
  dashboardAccessStore: DashboardAccessStore;
  /** Sends each saved dashboard allow-list to Rome Cloud in the background. */
  visitorAllowListSync: VisitorAllowListSync;
  /** The chats the guardian's phone app holds open on the live-events socket. */
  phoneWatching?: PhoneWatching;
  /** Whether the guardian is at a web dashboard, from its signals on the live-events socket. */
  dashboardActivity?: DashboardActivity;
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
  /** Reports each guardian sign-in to Rome Cloud as a usage event. */
  loginUsage: LoginUsageSink;
  /** Use-side registry. Present but with zero registered descriptors in
   *  this phase — later phases register real integrations and route through it. */
  connectionRegistry?: ConnectionRegistry;
  /** Grant-setup sessions. In-memory, created alongside the
   *  registry; drives the generic setup routes. Present only when the
   *  registry is. */
  setupManager?: SetupManager;
}

export interface ApiHandle {
  port: number;
  close(): Promise<void>;
}
