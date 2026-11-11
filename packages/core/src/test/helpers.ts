import { romeToolPorts } from "../core/rome-tool-ports.js";
import { appGuardianProfile } from "../people/for-apps.js";
import { WebChatDashboardSessions } from "../webchat/webchat-dashboard-sessions.js";
import { createLogger } from "../logger.js";
import { sessionOpeningFor } from "../core/session-opening.js";
import { ROME_AGENT_TRAITS } from "../concierge/agent-traits.js";
import { readAnswerShape, romeSessionTracing } from "../agent/index.js";
import { TurnUsageReporter } from "../apps/turn-usage-reporter.js";
import { agentFolders } from "../paths.js";
import type { ExternalAgents } from "../chats/accounts/agents-accounts.js";
import {
  createActionEngineRepos,
  createTestDb,
  kindChannelOf,
  testAccountLinkOf,
  type TestDb,
} from "./db.js";
import * as schema from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import { givenGrant } from "../connections/connection.js";
import type { GrantValue } from "../connections/grant.js";
import type { Credential } from "../connections/types.js";
import type { AgentEvent, OutgoingMessage } from "../types.js";
import type { Agent, AgentDefinition } from "../agent/index.js";
import type { AgentRunnerInterface, RunParams } from "../core/types.js";
import type {
  ModelProvider,
  ModelRunParams,
  ModelSession,
  ModelSessionParams,
} from "../core/agent-runner.js";
import { AgentRunner, createSessionFromRun } from "../core/agent-runner.js";
import { AgentLoader } from "../apps/agent-loader.js";
import { agentsByLegacyName } from "../apps/agents-by-legacy-name.js";
import { SkillLoader } from "../apps/skill-loader.js";
import { createTestSystemPrompts } from "./system-prompts.js";
import {
  createModelAccounts,
  ClaudeAccount,
  type ModelAccount,
  type CodexLogins,
  romeCreditsProxyRoutes,
} from "../agent/index.js";
import { createModelResolver } from "../agent/index.js";
import { normalizeConversationTitle } from "../core/conversation-title.js";
import { createSessions } from "../agent/index.js";
import { createAgentTurnStreamRegistry } from "../core/agent-turn-stream-registry.js";
import {
  subagentLiveTurns,
  subagentSessions,
  subagentTurnLog,
} from "../core/subagent-call-ports.js";
import { createSubagentCalls } from "../agent/index.js";
import { TurnListeners } from "../agent/index.js";
import { AppTurnHooks } from "../apps/app-turn-hooks.js";
import { DrizzleSessionRepository, type SessionRepository } from "../agent/index.js";
import { ApprovalHandler } from "../apps/actions/approval-handler.js";
import { createBackendTurnRunner } from "../apps/actions/backend-turn.js";
import { RoutineEngine } from "../routines/engine.js";
import { systemClock } from "../lib/clock.js";
import { EventCatalog } from "../event-catalog.js";
import { Permissions } from "../access/permissions.js";
import { loadAppPermissions } from "../apps/app-permissions.js";
import { DashboardAccessState } from "../access/dashboard-access-state.js";
import { DashboardAccessStore } from "../access/dashboard-access-store.js";
import { VisitorAllowListSync } from "../access/visitor-allowlist-sync.js";
import { ScheduleTriggerProvider } from "../routines/schedule-trigger-provider.js";
import { EventBusTriggerProvider } from "../routines/event-bus-trigger-provider.js";
import { EventBus } from "../events/event-bus.js";
import { RelayDrainer } from "../relay/drainer.js";
import { SystemUpgradeService } from "../instance/system-upgrade/service.js";
import { createOgImageStore } from "../apps/og/store.js";
import type {
  ChannelMessage,
  ChatId,
  ChatSettingsControl,
  MessageReceipt,
} from "@rome-os/app-runtime";
import type { Talker } from "../connections/types.js";
import type { ConnectionRegistry } from "../connections/registry.js";
import { AppConnectionAccessRepository } from "../connections/app-connection-access.js";
import { PeopleRepository } from "../db/repositories/people.js";
import { GuardianLinkCodes } from "../people/guardian-link-code.js";
import { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { LinkedInStoreRepository } from "../db/repositories/linkedin-store.js";
import { WhatsAppStoreRepository } from "../db/repositories/whatsapp-store.js";
import { LinkedInAccounts } from "../chats/accounts/linkedin.js";
import { WhatsAppAccounts } from "../chats/accounts/whatsapp.js";
import { createAccountNames } from "../chats/accounts/account-names.js";
import type { Accounts } from "../chats/accounts/accounts.js";
import type { Channel, Channels } from "../chats/connected-accounts/connected-account.js";
import type {
  ChannelOf,
  ConnectionPortsDeps,
} from "../chats/connected-accounts/connection-ports.js";
import type { Connection, ConnectionDescriptor } from "../connections/types.js";
import { channelList } from "../chats/connected-accounts/connected-account-list.js";
import { createChannelsService } from "../apps/accounts-service.js";
import { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import { ApprovalsRepository } from "../apps/repositories/approvals.js";
import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import type { AccountLink } from "@rome/api-types/account-agents";
import type { AccountLinkOf } from "../chats/connected-accounts/account-links.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { AppKeysRepository } from "../apps/repositories/app-keys.js";
import { AppKeyInjector } from "../apps/app-keys/injector.js";
import { PoliciesRepository } from "../db/repositories/policies.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { chatsWiring } from "../chats-wiring.js";
import { openChannelChat, type OpenSpeakerDeps } from "../connections/open-chat.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { ActionExecutionsRepository } from "../apps/repositories/action-executions.js";
import { ExecutionJournalRepository } from "../apps/repositories/execution-journal.js";
import { WebhookInvocationsRepository } from "../apps/repositories/webhook-invocations.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { ActionEngine, type ActionEngineRepositories } from "../apps/actions/engine.js";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { ActionLoader } from "../apps/actions/loader.js";
import {
  assertNoAppActionLoadFailures,
  registerAppActions,
} from "../apps/actions/app-actions-wiring.js";
import { appsRoutes } from "../api/routes/apps.js";
import { migrateAppByMetadata } from "../db/migrate.js";
import { createAppDomain } from "../apps/index.js";
import { createAppRuntimeRepositories } from "../apps/repositories.js";
import type { BundleFetcher } from "../apps/installer.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { AppManager } from "../apps/manager.js";
import {
  createRomeCloudListingClient,
  type RomeCloudListingClient,
} from "../apps/rome-cloud-listing-client.js";
import { createAppStoreService } from "../apps/store-service.js";
import { type CatalogEvent, isResolvedApp } from "../apps/state.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { FeedbackClient, AGENT_REPORTS_ENABLED_KEY } from "../lib/feedback-client.js";
import { assembleDiagnosticBundle } from "../instance/diagnostics.js";
import type { ApiDeps } from "../api/deps.js";
import type { FavorService } from "../favors/index.js";
import { Hono } from "hono";
import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export * from "./db.js";

/** Chats over `db` as Rome wires it, reading the channel records `db`
 *  holds. Every channel is active: one its record names no account for is
 *  the account named like it, so tests need not record one per channel. */
export function testChatsWiring(db: DrizzleDb) {
  const records = new ChannelRecordsRepository(db, testAccountLinkOf);
  return chatsWiring(db, {
    accountOf: (channel) =>
      records.accountOf(channel) ?? { platform: records.platformOfChannel(channel), id: channel },
    platformOfChannel: (name) => records.platformOfChannel(name),
    channelsOn: (platform) => [...new Set([...records.namesOn(platform), platform])],
  });
}

/** What opens a speaker over `db`: {@link testChatsWiring}'s chats,
 *  adapters and speakers. */
export function testOpenSpeakerDeps(db: DrizzleDb): OpenSpeakerDeps {
  const wired = testChatsWiring(db);
  return { chats: wired.chats, adapters: wired.adapters, speakers: wired.speakers };
}

/** Maps a channel to its connection kind through `db`'s channel records, as Rome does. */
export function recordedConnectionKindOf(db: DrizzleDb): ConnectionKindOfChannel {
  const records = new ChannelRecordsRepository(db, testAccountLinkOf);
  return (channel) => records.connectionKindOf(channel);
}

// MockModelProvider — returns predetermined AgentEvent sequences

export class MockModelProvider implements ModelProvider {
  readonly id = "mock" as const;
  builtinTools: ReadonlySet<string> = new Set();
  private responses: AgentEvent[][];
  private callIndex = 0;

  /** Track all calls made to run() for assertions */
  calls: ModelRunParams[] = [];
  /** Track all openSession calls for assertions */
  sessions: ModelSessionParams[] = [];

  constructor(responses: AgentEvent[][] = []) {
    this.responses = responses;
  }

  async *run(params: ModelRunParams): AsyncIterable<AgentEvent> {
    this.calls.push(params);
    const messages = this.responses[this.callIndex++] ?? [];
    for (const msg of messages) {
      yield msg;
    }
  }

  async openSession(params: ModelSessionParams): Promise<ModelSession> {
    this.sessions.push(params);
    return createSessionFromRun(this.id, (runParams) => this.run(runParams), params);
  }
}

// FakeTransport — the platform end of a test channel

let sentCount = 0;

/** One message Rome sent on a fake transport. */
export interface SentMessage {
  chatId: ChatId;
  message: OutgoingMessage;
}

/**
 * The platform behind one test channel: what its Connection's Talk hears from
 * and sends to. Inbound arrives as the channel's own record, a
 * `ChannelMessage`, the way every production transport delivers it.
 *
 * Replace a method with `rs.spyOn` to fake what the platform does: the Talk
 * reads each one at call time.
 */
export class FakeTransport {
  /** Every message sent and accepted, oldest first. */
  readonly sentMessages: SentMessage[] = [];
  private readonly listeners = new Set<(message: ChannelMessage) => Promise<void>>();

  constructor(readonly channel = "test") {}

  async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    this.sentMessages.push({ chatId, message });
    // A message id, the way every real talker answers with one, so Rome's
    // transcript of a send is recorded under it as it is in production.
    return { chatId, messageId: `sent-${++sentCount}` };
  }

  /** What the Connection's talker delivers through. */
  listen(listener: (message: ChannelMessage) => Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Deliver one inbound message on this channel, built by `buildMessage`
   * with this channel's name. Resolves once every listener has taken it,
   * which on a channel's inbound port is after admission and before any
   * subscriber's handler finishes (R4 buffers it). Answers the message.
   */
  async receive(overrides: Partial<ChannelMessage> = {}): Promise<ChannelMessage> {
    const message = buildMessage({ channel: this.channel, ...overrides });
    await Promise.all([...this.listeners].map((listener) => listener(message)));
    return message;
  }
}

/** What a test Connection's live talker offers: sending and its features. */
export type TestTalker = Omit<Talker, "start" | "stop">;

/** The Connections a test channel list reads: one `test:<name>` Connection per
 *  fake transport, each with a live talker over its transport. */
export type TestConnections = ConnectionPortsDeps["registry"] &
  Pick<ConnectionRegistry, "get" | "all">;

/**
 * Builds the test Connections. `talker` edits one connection kind's talker, for a test
 * that fakes what a Connection offers; the default talker addresses a direct
 * chat by the contact, like the two channels that ship with sending. Every
 * Connection hears its transport's deliveries.
 */
export function createTestConnections(
  transports: ReadonlyMap<string, FakeTransport>,
  talker: (connectionKind: string, talker: TestTalker) => TestTalker = (_connectionKind, talker) =>
    talker,
): TestConnections {
  const connections = new Map<string, Connection>();
  for (const [connectionKind, transport] of transports) {
    const id = `test:${connectionKind}`;
    const live = talker(connectionKind, talkerOver(transport));
    connections.set(id, {
      id,
      connectionKind,
      withTalker: (call: (talker: TestTalker) => unknown) => call(live),
      hearTalker: (handler: (message: ChannelMessage) => Promise<void>) =>
        transport.listen(handler),
      isUnlocked: (capability: string) => capability === "chat",
      status: () => ({ chat: { state: "unlocked" } }),
    } as unknown as Connection);
  }
  const find = (connectionKind: string) => connections.get(`test:${connectionKind}`);
  return {
    find: (connectionKind) => {
      const connection = find(connectionKind);
      return connection ? [connection] : [];
    },
    get: (id) => {
      const connection = connections.get(id);
      if (!connection) throw new Error(`unknown connection "${id}"`);
      return connection;
    },
    all: () => [...connections.values()],
    getDescriptor: (connectionKind) =>
      find(connectionKind)
        ? ({
            connectionKind,
            auth: {},
            capabilities: { talker: {} },
          } as unknown as ConnectionDescriptor)
        : null,
    // Every test Connection is unlocked from the start, so a handler hears
    // each of them at once, as the registry's replay does.
    onUnlocked: (_capability, handler) => {
      for (const connection of connections.values()) handler(connection);
    },
    registeredKinds: () => [...transports.keys()],
  };
}

/** A talker over a fake transport. */
function talkerOver(transport: FakeTransport): TestTalker {
  return {
    send: (chatId, message) => transport.send(chatId, message),
    directMessaging: {
      async chatFor(channelUserId: string) {
        return channelUserId as ChatId;
      },
    },
  };
}

/** An address book with nobody in it, for a rig that reads no People. */
export const noAccounts: Accounts = {
  listAccounts: async () => ({ accounts: [] }),
  resolve: async () => null,
};

/** The harness's channel list over `connections`, built by the production
 *  `channelList`. A test that fakes a talker rebuilds the list with it. */
export function testChannels(
  deps: Pick<TestDeps, "db" | "whatsAppAccounts" | "linkedInAccounts">,
  connections: TestConnections,
): Channels {
  return channelList({
    db: deps.db,
    whatsAppAccounts: deps.whatsAppAccounts,
    linkedInAccounts: deps.linkedInAccounts,
    connections: { registry: connections, channelOf: kindChannelOf },
  });
}

/** Look a channel up by name, as the backend-turn runner does. */
export function channelNamed(channels: Channels): (name: string) => Channel | null {
  return (name) => channels.find((channel) => channel.name === name) ?? null;
}

const emptyChatSettings: ChatSettingsControl = {
  async list() {
    return { items: [] };
  },
  async get() {
    throw new Error("Conversation settings are unavailable in this test");
  },
  async update() {
    throw new Error("Conversation settings are unavailable in this test");
  },
  async reset() {
    throw new Error("Conversation settings are unavailable in this test");
  },
};

// createMockAgentRunner — mock returning predetermined responses

export function createMockAgentRunner(
  responses: AgentEvent[][] = [],
): AgentRunnerInterface & { calls: RunParams[] } {
  let callIndex = 0;
  const calls: RunParams[] = [];

  return {
    calls,
    async *run(params: RunParams): AsyncIterable<AgentEvent> {
      calls.push(params);
      const messages = responses[callIndex++] ?? [];
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

// buildMessage — an inbound ChannelMessage with defaults

export function buildMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channel: "telegram",
    direction: "inbound",
    messageId: "msg-001",
    chatId: "thread-001" as ChatId,
    senderId: "user-123",
    senderDisplayName: "Test User",
    text: "Hello, world!",
    attachments: [],
    timestamp: new Date("2026-01-15T10:00:00Z"),
    thread: { kind: "dm" },
    ...overrides,
  };
}

// buildAgentConfig — an agent file's contents, with defaults

/** What an agent's file holds: its definition and its local name. */
export type TestAgentFile = AgentDefinition & { name: string };

export function buildAgentConfig(overrides?: Partial<TestAgentFile>): TestAgentFile {
  return {
    name: "test-agent",
    description: "A test agent",
    tier: "small",
    reasoningEffort: "high",
    systemPromptPrefix: "You are a test agent.",
    tools: [],
    permissionMode: "default",
    ...overrides,
  };
}

/** An installed core agent, for tests that stub the catalog. Its local name is the id's last part unless `name` says otherwise. */
export function buildAgent(id: string, overrides?: Partial<TestAgentFile>): Agent {
  const { name: localName, ...definition } = buildAgentConfig({
    name: id.split(":").pop() ?? id,
    ...overrides,
  });
  return { name: id, localName, ownerType: "core", ownerId: "core", definition };
}

// buildTestDeps — wires real repos from a test DB plus mock channels

export interface TestDeps extends ApiDeps {
  // Test-owned extras not part of the ApiDeps surface.
  /** The LinkedIn inbox mirror. No route reads it — the poller fills it and
   *  the person timeline reads through it — so a test that wants LinkedIn
   *  history seeds it here rather than through the API's own dependencies. */
  linkedInStoreRepo: LinkedInStoreRepository;
  /** The WhatsApp mirror behind `whatsAppAccounts`. No route reads it either,
   *  so a test seeds WhatsApp contacts and history here. */
  whatsAppStoreRepo: WhatsAppStoreRepository;
  /** The address books behind `channels`, kept reachable so a test can rebuild
   *  the list against a different database handle. */
  whatsAppAccounts: WhatsAppAccounts;
  linkedInAccounts: LinkedInAccounts;
  sessionRepository: SessionRepository;
  policiesRepo: PoliciesRepository;
  executionJournalRepo: ExecutionJournalRepository;
  /** The platform end of each channel `connections` backs, by channel name. */
  transports: Map<string, FakeTransport>;
  /** The Connections behind `channels` and `channelsService`. A test that
   *  fakes a talker builds its own with `createTestConnections`. */
  connections: TestConnections;
}

export interface BuildTestDepsOptions {
  channels?: string[];
  /** The agents Rome Cloud lists. Agents is not connected by default. */
  assistants?: ExternalAgents;
}

const unavailableFavorService: FavorService = {
  async getBalance() {
    throw new Error("favor_service_unavailable");
  },
  async listLedger() {
    throw new Error("favor_service_unavailable");
  },
  async getActionRequest() {
    throw new Error("favor_service_unavailable");
  },
  async syncActionRequests() {
    return { requests: [], nextCursor: new Date(0).toISOString() };
  },
  async listActionRequests() {
    return { requests: [], nextCursor: new Date(0).toISOString() };
  },
  async requestAction() {
    return { status: "error", error: "favor_service_unavailable" };
  },
  async resolveActionRequest() {
    throw new Error("favor_service_unavailable");
  },
  async claimDispatch() {
    return { status: "not_claimable", reason: "blocked" };
  },
  async renewDispatchClaim() {
    throw new Error("favor_service_unavailable");
  },
  async reportDispatchResult() {},
  async listRechargePacks() {
    return { packs: [] };
  },
  async createRechargeCheckout() {
    throw new Error("favor_service_unavailable");
  },
  async syncActionRequirements() {
    return { synced: 0 };
  },
};

// Distinguishes the never-created app-domain paths handed to each
// buildTestDeps call, so a test that unexpectedly boots the AppManager fails
// in its own sandbox instead of sharing state with parallel tests.
let testDepsSeq = 0;

export async function buildTestDeps(
  db: DrizzleDb,
  options: BuildTestDepsOptions = {},
): Promise<TestDeps> {
  const channelNames = options.channels ?? ["telegram", "webchat"];
  const transports = new Map<string, FakeTransport>();
  for (const name of channelNames) {
    transports.set(name, new FakeTransport(name));
  }

  const appConnectionAccessRepo = new AppConnectionAccessRepository(db);
  const peopleRepo = new PeopleRepository(db);
  const channelRecords = new ChannelRecordsRepository(db, testAccountLinkOf);
  const whatsAppStoreRepo = new WhatsAppStoreRepository(db);
  const whatsAppAccounts = new WhatsAppAccounts(whatsAppStoreRepo);
  const linkedInStoreRepo = new LinkedInStoreRepository(db);
  const linkedInAccounts = new LinkedInAccounts(linkedInStoreRepo);
  const sentinelLogRepo = new SentinelLogRepository(db, (name) =>
    channelRecords.platformOfChannel(name),
  );
  const connections = createTestConnections(transports);
  const channels = testChannels({ db, whatsAppAccounts, linkedInAccounts }, connections);
  const accountNames = createAccountNames({
    channels,
    sentinelLogRepo,
    platformOfChannel: (name) => channelRecords.platformOfChannel(name),
  });
  const approvalsRepo = new ApprovalsRepository(db);
  const settingsRepo = new SettingsRepository(db);
  // A private env object per deps bag: route tests exercise apply/remove
  // without touching the real process.env of the test runner.
  const appKeysRepo = new AppKeysRepository(db);
  const appKeyInjector = new AppKeyInjector({});
  const policiesRepo = new PoliciesRepository(db);
  // Chats as production wires it, with each dashboard chat's lines in it.
  // Every test channel is active: one its record names no account for is
  // the account named like it, so tests need not record one per channel.
  const accountOf = (channel: string) =>
    channelRecords.accountOf(channel) ?? {
      platform: channelRecords.platformOfChannel(channel),
      id: channel,
    };
  const chatsWired = chatsWiring(db, {
    accountOf,
    platformOfChannel: (name) => channelRecords.platformOfChannel(name),
    channelsOn: (platform) => channelRecords.namesOn(platform),
  });
  const webchatRepo: WebChatRepository = new ChatsWebChatRepository(db, {
    chats: chatsWired.chats,
    lines: chatsWired.messages,
    links: chatsWired.links,
  });
  const appRuntimeRepositories = createAppRuntimeRepositories({
    settingsRepo,
    webchatRepo,
    speakers: {
      chats: chatsWired.chats,
      adapters: chatsWired.adapters,
      speakers: chatsWired.speakers,
    },
    guardianProfile: appGuardianProfile({
      db,
      settingsRepo,
      reactivateFloating: () => routineEngine.reactivateFloating(),
    }),
  });
  const actionExecutionsRepo = new ActionExecutionsRepository(db);
  const executionJournalRepo = new ExecutionJournalRepository(db);
  const webhookInvocationsRepo = new WebhookInvocationsRepository(db);
  const routinesRepo = new RoutinesRepository(db);
  const routineRunsRepo = new RoutineRunsRepository(db);

  const actionRegistry = new ActionRegistryImpl();
  const actionEngine = new ActionEngine(
    actionRegistry,
    { executions: actionExecutionsRepo, approvals: approvalsRepo, journal: executionJournalRepo },
    // The host running the tests has no say over queued roots.
    { processRole: "main", memoryHeadroom: () => null },
  );

  const artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
  const actionLoader = new ActionLoader(artifactIdentity);
  const agentLoader = new AgentLoader(artifactIdentity, ROME_AGENT_TRAITS);
  const skillCatalog = new SkillLoader(artifactIdentity);
  const romeCloudListings = createRomeCloudListingClient();
  const appDomainRoot = join(tmpdir(), `rome-test-deps-${process.pid}-${++testDepsSeq}`);
  const { catalog: appCatalog, manager: appManager } = createAppDomain({
    lockfilePath: join(appDomainRoot, "apps.lock.json"),
    installedRoot: join(appDomainRoot, "apps", "installed"),
    romeCloudListings,
  });
  const appStore = createAppStoreService({ appCatalog });

  // The agent loader stays real but unloaded. Core agent YAMLs cannot load
  // here: `core:main` references the `assistant:explore` subagent,
  // and the loader fail-closes on unresolvable core-owned refs — production
  // only has a valid `main` because required first-party apps are installed
  // before startApi. Tests that exercise agent turns load fixture agents
  // explicitly (src/test/fixtures/agents/); a test that hits the default agent
  // path without doing so fails loudly with `Agent "main" not found`.
  const sessionRepository = new DrizzleSessionRepository(db, artifactIdentity);
  const systemPrompts = createTestSystemPrompts({ apps: appCatalog });
  const codexAccountChangedListeners = new Set<() => void>();
  const codexAccountService: ModelAccount & CodexLogins = {
    async report() {
      return {
        state: "available" as const,
        account: {
          loggedIn: true,
          authMode: "chatgpt" as const,
          planType: "plus" as const,
          accountType: "plus",
        },
      };
    },
    authorizationState() {
      return {
        running: false,
        mode: null,
        userCode: null,
        verificationUrl: null,
        lastError: null,
      };
    },
    async startBrowserAuthorization() {
      return { authorizationId: "test-browser-login", authUrl: "https://auth.openai.com/test" };
    },
    async startDeviceAuthorization() {
      return {
        authorizationId: "test-device-login",
        userCode: "TEST-CODE",
        verificationUrl: "https://auth.openai.com/codex/device",
      };
    },
    async cancelAuthorization() {},
    async revoke() {},
    login: () => ({ kind: "subscription" }),
    useLogin() {},
    onChanged(listener) {
      codexAccountChangedListeners.add(listener);
      return () => codexAccountChangedListeners.delete(listener);
    },
    close() {
      codexAccountChangedListeners.clear();
    },
  };
  // The real adapter: the dashboard route tests put a fake `claude` binary on
  // PATH and mock the revoked marker, and read status through it.
  const claudeAccount = new ClaudeAccount({ settingsRepo });
  const modelAccounts = createModelAccounts({
    accounts: { openai: codexAccountService, anthropic: claudeAccount },
    startRefresh: false,
    refreshIntervalMs: null,
  });
  const modelResolver = createModelResolver({
    providers: [new MockModelProvider()],
    accounts: modelAccounts,
  });
  const agentTurnStreamRegistry = createAgentTurnStreamRegistry();
  const subagentCalls = createSubagentCalls({
    dashboard: new WebChatDashboardSessions(webchatRepo),
    turnLog: subagentTurnLog(webchatRepo),
    liveTurns: subagentLiveTurns(agentTurnStreamRegistry),
  });
  const agentSessionManager = createSessions({
    agentLoader,
    sessionRepository,
    systemPrompts,
    modelResolver,
    skillCatalog,
    networkMcpServers: () => ({}),
    turnLifecycle: new TurnListeners(new AppTurnHooks()),
    readAnswerShape,
    sessionTracing: romeSessionTracing,
    turnUsage: new TurnUsageReporter(),
    folders: agentFolders(),
    log: createLogger("agent-session"),
    subagentCalls,
    subagentSessions: (manager, parentLink, inherited) =>
      subagentSessions(manager, parentLink, webchatRepo, inherited),
    ...romeToolPorts({
      actionRegistry,
      actionEngine,
    }),
  });
  const agentRunner = new AgentRunner(
    agentSessionManager,
    agentLoader,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sessionOpeningFor({ channelSurface: testChannelSurface }),
  );
  const backendTurnRunner = createBackendTurnRunner({
    agentRunner,
    channel: channelNamed(channels),
    // Opened as production opens an app's chat, so the session stands in
    // Chats as the speaker of the channel's account.
    chats: {
      ensureChannelChat: (input) =>
        openChannelChat(
          {
            webchatRepo,
            speakers: {
              chats: chatsWired.chats,
              adapters: chatsWired.adapters,
              speakers: chatsWired.speakers,
            },
          },
          input,
        ),
    },
    replies: chatsWired.replies,
  });
  const approvalHandler = new ApprovalHandler(
    approvalsRepo,
    executionJournalRepo,
    actionEngine,
    agentRunner,
    backendTurnRunner,
  );
  const routineEngine = new RoutineEngine(
    routinesRepo,
    routineRunsRepo,
    actionEngine,
    30_000,
    systemClock,
  );
  // Same provider set the daemon registers before the API comes up, so
  // routine trigger validation behaves identically here.
  routineEngine.registerProvider("schedule", new ScheduleTriggerProvider(routinesRepo));
  routineEngine.registerProvider(
    "event-bus",
    new EventBusTriggerProvider(new EventBus(), routinesRepo),
  );

  // Mirror daemon boot: the auth-edge snapshot is loaded from the persisted
  // `publicAccess` setting before serving (src/index.ts). Tests that change
  // the setting after construction refresh via permissions.replace(), exactly
  // like the /api/public-access PUT handler.
  const permissions = new Permissions();
  await loadAppPermissions(db, permissions);
  const dashboardAccessState = new DashboardAccessState();
  await dashboardAccessState.load(db);
  // Not linked, so a test that saves the allow-list never reaches the network.
  const dashboardAccessStore = new DashboardAccessStore(settingsRepo);
  const visitorAllowListSync = new VisitorAllowListSync({
    getEnrollmentId: () => null,
    onLinkChanged: () => () => {},
  });

  const ogImageStore = createOgImageStore(mkdtempSync(join(tmpdir(), "rome-og-test-")));
  const channelsService = createChannelsService({
    channels: () => channels,
    registry: connections,
    channelOf: kindChannelOf,
  });

  return {
    connections,
    channelsService,
    chatSettings: emptyChatSettings,
    actionEngine,
    actionLoader,
    db,
    appConnectionAccessRepo,
    sessionRepository,
    peopleRepo,
    guardianLinkCodes: new GuardianLinkCodes(),
    whatsAppStoreRepo,
    whatsAppAccounts,
    linkedInStoreRepo,
    linkedInAccounts,
    channels,
    platformOfChannel: (name: string) => channelRecords.platformOfChannel(name),
    recordedOn: (platform: string) => channelRecords.namesOn(platform),
    sendersOn: (platform: string) => channelRecords.sendersOn(platform),
    // The same account Chats reads each test channel as.
    accountOf,
    accountNames,
    assistants: options.assistants ?? { connected: () => false, list: async () => [] },
    sentinelLogRepo,
    approvalsRepo,
    approvalHandler,
    backendTurnRunner,
    settingsRepo,
    appKeysRepo,
    appKeyInjector,
    // Production's refresh also salts the module cache and reloads hook
    // chains; the deps bag has neither, so mirror the worker-pool slice.
    refreshAppRuntime: () => actionEngine.restartWorkerWarmPool(),
    appRuntimeRepositories,
    policiesRepo,
    webchatRepo,
    chats: chatsWired.chats,
    messages: chatsWired.messages,
    recording: {
      adapters: chatsWired.adapters,
      chats: chatsWired.chats,
      messages: chatsWired.messages,
    },
    actionExecutionsRepo,
    executionJournalRepo,
    webhookInvocationsRepo,
    routinesRepo,
    routineRunsRepo,
    routineEngine,
    eventCatalog: new EventCatalog(),
    appCatalog,
    ogImageStore,
    appManager,
    romeCloudListings,
    appStore,
    actionRegistry,
    agentLoader,
    agentsByName: () => agentsByLegacyName(agentLoader.list(), artifactIdentity.legacyBindings),
    accountListening: { changed: () => {} },
    skillCatalog,
    appsRoot: join(appDomainRoot, "apps"),
    agentSessionManager,
    sessionOpeningFor: sessionOpeningFor({ channelSurface: testChannelSurface }),
    conversationTitleGenerator: {
      async generate(firstMessage) {
        return normalizeConversationTitle(firstMessage) ?? "New Chat";
      },
    },
    agentRunner,
    subagentCalls,
    agentTurnStreamRegistry,
    modelAccounts,
    codexAccountService,
    claudeAccount,
    romeCreditsProxy: romeCreditsProxyRoutes("127.0.0.1"),
    permissions,
    dashboardAccessState,
    dashboardAccessStore,
    visitorAllowListSync,
    relayDrainer: new RelayDrainer([], async () => ({ status: 200 })),
    nodeDevices: {
      start: async () => {},
      listFiles: async () => ({ ok: false, code: "offline" }),
      listDevices: async () => ({ devices: [] }),
      renameDevice: async () => ({ ok: true }),
      removeDevice: async () => ({ ok: true }),
      getStatus: async () => ({
        connection: "not_configured",
        checkedAt: new Date().toISOString(),
        devices: [],
      }),
    },
    wechatApp: null,
    computerUse: {
      getStatus: async () => ({
        daemon: { status: "unavailable", version: null },
        checkedAt: new Date().toISOString(),
        connections: [],
      }),
    },
    favorService: unavailableFavorService,
    feedback: new FeedbackClient({
      diagnostics: () =>
        assembleDiagnosticBundle({
          settingsRepo,
          channelsService,
          appCatalog,
          bootVersionReport: { upgradedSinceLastBoot: false, previousVersion: null },
        }),
      agentReportsEnabled: async () =>
        (await settingsRepo.get(AGENT_REPORTS_ENABLED_KEY)) !== false,
    }),
    // The "nothing changed" report a versionless test boot produces; tests
    // exercising the upgrade notice construct their own report.
    bootVersionReport: { upgradedSinceLastBoot: false, previousVersion: null },
    // Inert in tests: checkAndOffer is never invoked here, and the Rome Cloud
    // client self-rejects on the versionless test boot if it ever were.
    systemUpgradeService: new SystemUpgradeService({ countdownMs: 600_000 }),
    isCloudAuthEnabled: async () => false,
    loginUsage: { recordLogin: () => {} },
    transports,
  };
}

// Metric test harness
//
// Wires an in-memory OpenTelemetry MeterProvider as the global provider so
// that lazy-init metric helpers in `telemetry.ts` route recordings to an
// inspectable exporter. Tests call `flush()` to collect the delta since the
// last flush and look up metrics by name.

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

type CollectedMetric = ReturnType<
  InMemoryMetricExporter["getMetrics"]
>[number]["scopeMetrics"][number]["metrics"][number];

export interface MetricHarness {
  /** Collect metrics recorded since the last flush, keyed by descriptor name. */
  flush(): Promise<Map<string, CollectedMetric>>;
  /** Shortcut: flush and return a single metric by name. */
  flushMetric(name: string): Promise<CollectedMetric | undefined>;
}

let sharedMetricHarness: MetricHarness | undefined;

/**
 * Install a shared in-memory MeterProvider for tests. Safe to call multiple
 * times — the first invocation wins and later callers get the same harness.
 * Uses DELTA temporality so each flush returns only the deltas since the
 * previous flush (counters don't accumulate across test cases).
 */
export function installTestMetricHarness(): MetricHarness {
  if (sharedMetricHarness) {
    return sharedMetricHarness;
  }

  const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  const flush = async (): Promise<Map<string, CollectedMetric>> => {
    exporter.reset();
    await provider.forceFlush();
    const byName = new Map<string, CollectedMetric>();
    for (const batch of exporter.getMetrics()) {
      for (const scope of batch.scopeMetrics) {
        for (const metric of scope.metrics) {
          byName.set(metric.descriptor.name, metric);
        }
      }
    }
    return byName;
  };

  sharedMetricHarness = {
    flush,
    flushMetric: async (name) => (await flush()).get(name),
  };
  return sharedMetricHarness;
}

// Span test harness
//
// One uniform install/teardown for the eight span-emission tests. Each test
// gets a fresh InMemorySpanExporter and a tracer provider; teardown disables
// the global trace + context state so the next test starts clean.
//
// `kind: "node"` installs `NodeTracerProvider` with an AsyncHooks context
// manager — required when assertions cross `await` boundaries (e.g.,
// `trace.getActiveSpan()` inside a generator body, or parent-child checks
// after a yield). `kind: "basic"` installs `BasicTracerProvider` (noop
// context manager) for purely synchronous span flows.

import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { node as nodeTracing } from "@opentelemetry/sdk-node";
import {
  setTelemetryBridge as setTelemetryBridgeOnSdk,
  type TelemetryBridge,
} from "@rome-os/app-runtime";
import { testChannelSurface } from "./channel-surface.js";
export interface SpanHarness {
  exporter: InMemorySpanExporter;
  shutdown(): Promise<void>;
  /** Force-flush + return all finished spans recorded so far. */
  finishedSpans(): Promise<ReadableSpan[]>;
}

export function installTestSpanHarness(kind: "basic" | "node" = "basic"): SpanHarness {
  trace.disable();
  context.disable();
  const exporter = new InMemorySpanExporter();
  let shutdown: () => Promise<void>;
  if (kind === "node") {
    const provider = new nodeTracing.NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
    shutdown = async () => {
      await provider.forceFlush();
      context.disable();
      trace.disable();
      await provider.shutdown();
      exporter.reset();
    };
    return {
      exporter,
      shutdown,
      finishedSpans: async () => {
        await provider.forceFlush();
        return exporter.getFinishedSpans();
      },
    };
  }
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  shutdown = async () => {
    await provider.forceFlush();
    trace.disable();
    await provider.shutdown();
    exporter.reset();
  };
  return {
    exporter,
    shutdown,
    finishedSpans: async () => {
      await provider.forceFlush();
      return exporter.getFinishedSpans();
    },
  };
}

/**
 * Install a minimal OTEL-backed `TelemetryBridge` so `@rome-os/app-runtime`'s
 * `withRomeSpan` / `startRomeSpan` route through the active tracer (which is
 * presumed to have been installed via `installTestSpanHarness`). Production
 * wires the real bridge in `initTelemetry()`; tests use this shim instead.
 */
export function installTestTelemetryBridge(): void {
  const bridge: TelemetryBridge = {
    withRomeSpan: (name, attrs, fn) =>
      trace
        .getTracer("rome")
        .startActiveSpan(
          name,
          { attributes: attrs as Record<string, string | number | boolean> },
          async (span) => {
            try {
              return await fn();
            } finally {
              span.end();
            }
          },
        ),
    startRomeSpan: (name, attrs) => {
      trace
        .getTracer("rome")
        .startSpan(name, {
          attributes: attrs as Record<string, string | number | boolean>,
        })
        .end();
    },
    currentSessionId: () => undefined,
    runWithSession: (_sessionId, fn) => fn(),
  };
  setTelemetryBridgeOnSdk(bridge);
}

export function clearTestTelemetryBridge(): void {
  setTelemetryBridgeOnSdk(null);
}

export interface AppLifecycleHarness {
  profileRoot: string;
  appsRoot: string;
  lockfilePath: string;
  installedRoot: string;
  db: DrizzleDb;
  appManager: AppManager;
  appCatalog: AppCatalog;
  actionRegistry: ActionRegistryImpl;
  actionLoader: ActionLoader;
  agentLoader: AgentLoader;
  skillCatalog: SkillLoader;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  hasAction(name: string): boolean;
  /** Bypasses the ActionEngine subprocess fork — tests don't need a worker entry. */
  invokeAction(name: string, args?: Record<string, unknown>): Promise<unknown>;
  restart(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface CreateAppLifecycleHarnessOptions {
  profileRoot?: string;
  bundleFetcher?: BundleFetcher;
  /** Override the Rome Cloud listings client used by the `/apps/updates` route. */
  romeCloudListings?: RomeCloudListingClient;
}

interface HarnessRuntime {
  appCatalog: AppCatalog;
  appManager: AppManager;
  actionRegistry: ActionRegistryImpl;
  actionLoader: ActionLoader;
  agentLoader: AgentLoader;
  skillCatalog: SkillLoader;
  router: Hono;
}

export async function createAppLifecycleHarness(
  options: CreateAppLifecycleHarnessOptions = {},
): Promise<AppLifecycleHarness> {
  const profileRoot = options.profileRoot ?? mkdtempSync(join(tmpdir(), "rome-app-e2e-"));
  const appsRoot = join(profileRoot, "apps");
  const lockfilePath = join(profileRoot, "apps.lock.json");
  const installedRoot = join(appsRoot, "installed");

  await mkdir(installedRoot, { recursive: true });

  const { db, close: closeDb } = createTestDb();
  const artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };

  async function buildRuntime(): Promise<HarnessRuntime> {
    const { manager: appManager, catalog: appCatalog } = createAppDomain({
      lockfilePath,
      installedRoot,
      bundleFetcher: options.bundleFetcher,
      romeCloudListings: options.romeCloudListings,
    });
    const actionRegistry = new ActionRegistryImpl(artifactIdentity);
    const actionLoader = new ActionLoader(artifactIdentity);
    const agentLoader = new AgentLoader(artifactIdentity, ROME_AGENT_TRAITS);
    const skillCatalog = new SkillLoader(artifactIdentity);

    appCatalog.subscribe(async function agentLoaderSubscriber() {
      try {
        await agentLoader.loadFromCatalog(appCatalog);
      } catch {
        // swallow — partial-state failures are observable via route reads
      }
    });
    appCatalog.subscribe(async function actionLoaderSubscriber() {
      try {
        await actionLoader.loadFromCatalog(appCatalog);
      } catch {
        // see above
      }
    });
    appCatalog.subscribe(async function skillCatalogSubscriber() {
      try {
        await skillCatalog.loadFromCatalog(appCatalog);
      } catch {
        // see above
      }
    });

    // Must run before the appActions subscriber so action constructors see
    // their DB tables.
    appCatalog.subscribe(async function migrationSubscriber(event: CatalogEvent) {
      if (event.change === "removed") return;
      const current = event.current;
      if (!isResolvedApp(current) || current.db == null) return;
      try {
        await migrateAppByMetadata(db, current.db);
      } catch {
        // see above
      }
    });

    const actionEngine = new ActionEngine(actionRegistry, createActionEngineRepos(db), {
      processRole: "worker",
    });
    const settingsRepo = new SettingsRepository(db);
    const webchatRepo: WebChatRepository = new ChatsWebChatRepository(db);
    const appRuntimeRepositories = createAppRuntimeRepositories({
      settingsRepo,
      webchatRepo,
      speakers: testOpenSpeakerDeps(db),
    });
    const appActionDeps = { actionRegistry, actionEngine, db };
    appCatalog.subscribe(async function appActionsSubscriber(event: CatalogEvent) {
      actionRegistry.unregisterOwnedBy("app", event.appId);
      if (event.change === "removed") return;
      const current = event.current;
      if (!isResolvedApp(current)) return;
      const result = await registerAppActions(
        actionLoader,
        actionRegistry,
        appCatalog,
        appActionDeps,
        { db, actionEngine, repositories: appRuntimeRepositories },
        { onlyAppId: event.appId },
      );
      assertNoAppActionLoadFailures(result.failed, "main");
    });

    const apiDeps: ApiDeps = {
      ...(await buildTestDeps(db)),
      actionEngine,
      actionRegistry,
      settingsRepo,
      webchatRepo,
      appRuntimeRepositories,
      appCatalog,
      appManager,
      appsRoot,
      ...(options.romeCloudListings ? { romeCloudListings: options.romeCloudListings } : {}),
    };
    const router = new Hono();
    router.route("/", appsRoutes(apiDeps));

    return {
      appCatalog,
      appManager,
      actionRegistry,
      actionLoader,
      agentLoader,
      skillCatalog,
      router,
    };
  }

  let runtime = await buildRuntime();
  await runtime.appManager.boot();

  async function honoFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(`http://app-e2e.test${path.startsWith("/") ? path : `/${path}`}`);
    return runtime.router.fetch(new Request(url, init));
  }

  function hasAction(name: string): boolean {
    return runtime.actionRegistry.has(name);
  }

  async function invokeAction(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const action = runtime.actionRegistry.get(name);
    if (!action) {
      throw new Error(`Action "${name}" not found in test harness registry`);
    }
    return await action.execute(args);
  }

  async function restart(): Promise<void> {
    runtime = await buildRuntime();
    await runtime.appManager.boot();
  }

  async function cleanup(): Promise<void> {
    closeDb();
    if (options.profileRoot == null) {
      await rm(profileRoot, { recursive: true, force: true });
    }
  }

  return {
    profileRoot,
    appsRoot,
    lockfilePath,
    installedRoot,
    db,
    get appManager() {
      return runtime.appManager;
    },
    get appCatalog() {
      return runtime.appCatalog;
    },
    get actionRegistry() {
      return runtime.actionRegistry;
    },
    get actionLoader() {
      return runtime.actionLoader;
    },
    get agentLoader() {
      return runtime.agentLoader;
    },
    get skillCatalog() {
      return runtime.skillCatalog;
    },
    fetch: honoFetch,
    hasAction,
    invokeAction,
    restart,
    cleanup,
  } as AppLifecycleHarness;
}

/**
 * Make each named channel one of the guardian's own connected accounts: a
 * channel record that knows its account, a live grant reaching that account,
 * and a link from it to the guardian. A person's page reads and sends only
 * over the guardian's own accounts, so a test of that page names the channels
 * it reads through here. `guardianId` is the seeded guardian's.
 */
export function ownedByGuardian(
  db: DrizzleDb,
  peopleRepo: PeopleRepository,
  guardianId: string,
  owned: readonly { channel: string; platform: string }[],
): void {
  for (const { channel, platform } of owned) {
    const account = { platform, id: `guardian-on-${channel}` };
    db.insert(schema.channels)
      .values({
        id: channel,
        connectionKind: channel,
        platform,
        platformAccountId: account.id,
        connectionId: null,
        createdAt: new Date(0),
      })
      .onConflictDoUpdate({
        target: schema.channels.id,
        set: { platformAccountId: account.id },
      })
      .run();
    db.insert(schema.connectionGrants)
      .values({
        custody: `test:guardian:${channel}`,
        state: "authorized",
        platform,
        accountId: account.id,
      })
      .run();
    peopleRepo.linkStated(account, guardianId);
  }
}

/** A grant, as a fix or a connect leaves it, that reaches the account
 *  `accountId` on `platform`. */
export function grantReaching(platform: string, accountId: string): GrantValue {
  return givenGrant(
    new Date("2026-01-01T00:00:00.000Z"),
    { material: { token: "test" } } as unknown as Credential,
    "test-epoch",
    undefined,
    { platform, accountId },
  );
}
