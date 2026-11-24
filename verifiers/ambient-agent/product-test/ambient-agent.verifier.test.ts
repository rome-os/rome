// Rule 4(b) of the ambient agent goal, rule set V4: an agent in a shared
// group chat, mentioned by a member who is not the guardian, recalls what
// others said there without mentioning it, and says nothing when nobody
// mentions it. The chat lives on a stand-in connection that does three things
// only: it delivers the messages that mention Rome's account, sends a message
// to a named chat and thread, and answers a read of a chat's messages from its
// own log. So the agent can know the rest only by reading the platform at the
// mention. The mention travels the path a real one takes, wired as index.ts
// wires it: registry, channel ports, recording, the Inbox hook and its
// message handler, the agent session, and the send back out. The model is
// scripted, and answers with a value only when the text it was shown holds it.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { Channel, ChannelMessage, ChatId, ThreadContext } from "@rome-os/app-runtime";
import { stringify as stringifyYaml } from "yaml";
import { createHook } from "../../../rome_apps/inbox/src/hooks/channel-message/index.js";
import { createMessageHandlerAction } from "../../../rome_apps/inbox/src/actions/message-handler/index.js";
import { createAction as createSendMessageAction } from "../../../rome_apps/system/src/actions/send-message/index.js";
import {
  createModelResolver,
  createSessions,
  DrizzleSessionRepository,
  readAnswerShape,
  romeSessionTracing,
  TurnListeners,
} from "./agent/index.js";
import { createChannelsService } from "./app-host/accounts-service.js";
import { AgentLoader } from "./app-host/agent-loader.js";
import { AppTurnHooks } from "./app-host/app-turn-hooks.js";
import { createAppRuntimeRepositories } from "./app-host/repositories.js";
import { SkillLoader } from "./app-host/skill-loader.js";
import { TurnUsageReporter } from "./app-host/turn-usage-reporter.js";
import { ActionEngine } from "./apps/actions/engine.js";
import { ActionRegistryImpl } from "./apps/actions/registry.js";
import type { ActionConfig } from "./apps/actions/types.js";
import { createEmptyLegacyArtifactBindings } from "./apps/artifact-id.js";
import {
  legacyChatIdChannels,
  legacyChatIdChannelsService,
  legacyChatIdSettings,
  legacyChatIdStop,
} from "./apps/legacy-chat-id.js";
import { ChatSettingsRepository, ChatSettingsService } from "./chat-settings/index.js";
import { channelList } from "./chats/connected-accounts/connected-account-list.js";
import { romeAccounts } from "./chats/connected-accounts/rome-accounts.js";
import { ChatEvents } from "./chats/storage/events.js";
import { chatsWiring } from "./chats-wiring.js";
import { ROME_AGENT_TRAITS } from "./concierge/agent-traits.js";
import { STRANGER_PERSON_ID } from "./constants.js";
import { connectionPorts } from "./chats/connected-accounts/connection-ports.js";
import { inboundRecording } from "./connections/inbound-recording.js";
import type { Message } from "./connections/message.js";
import { openChannelChat } from "./connections/open-chat.js";
import { ConnectionRegistry } from "./connections/registry.js";
import { DrizzleConnectionsRepository } from "./connections/repository-db.js";
import type { ConnectionDescriptor, Talker } from "./connections/types.js";
import { AgentRunner } from "./core/agent-runner.js";
import { chatPromptFacts } from "./core/chat-prompt-facts.js";
import { romeToolPorts } from "./core/rome-tool-ports.js";
import { sessionOpeningFor, talkerChannelSurface } from "./core/session-opening.js";
import { ActionExecutionsRepository } from "./apps/repositories/action-executions.js";
import { ApprovalsRepository } from "./apps/repositories/approvals.js";
import { ExecutionJournalRepository } from "./apps/repositories/execution-journal.js";
import { SentinelLogRepository } from "./db/repositories/sentinel-log.js";
import { PoliciesRepository } from "./db/repositories/policies.js";
import { SettingsRepository } from "./db/repositories/settings.js";
import { createLogger } from "./logger.js";
import { guardedSend } from "./participation/send-gate/index.js";
import { wakeGateLoader } from "./participation/wake-gate/index.js";
import { agentFolders } from "./paths.js";
import { appPersonMapping } from "./people/app-person-mapping.js";
import { DrizzlePeopleRepository } from "./people/infrastructure/drizzle-people-repository.js";
import { messagesSaid } from "./sessions/messages-said.js";
import { createTestDb, type TestDb } from "./test/db.js";
import { buildAgentConfig } from "./test/helpers.js";
import { FakeModel, result } from "./test/kit/fake-model.js";
import { bothAvailable, fakeAccounts } from "./test/kit/model-accounts.js";
import { createTestSystemPrompts } from "./test/system-prompts.js";
import { ChatsWebChatRepository } from "./webchat/chats-webchat-repository.js";

const KIND = "standin";
const BOT = "standin-bot";
const CHAT = "group-1" as ChatId;
const GUARDIAN = { accountId: "u-grace", name: "Grace" };
// Persons A and B of the rules: members of the workspace who are not the guardian.
const ASKER = { accountId: "u-hal", name: "Hal" };
const MEMBERS = [
  { accountId: "u-ada", name: "Ada" },
  { accountId: "u-linus", name: "Linus" },
  { accountId: "u-mary", name: "Mary" },
];

const config = (name: string): ActionConfig => ({
  name,
  type: "system",
  description: name,
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "write",
});

/** The platform: every message said in the group, oldest first, of which
 *  only mentions of Rome's account are delivered. */
function standInPlatform() {
  const log: ChannelMessage[] = [];
  const sent: { chatId: ChatId; threadId?: string; text: string }[] = [];
  let deliver: ((message: Message) => void | Promise<void>) | undefined;
  let clock = Date.now() - 3_600_000;
  const append = (
    sender: { accountId: string; name: string },
    text: string,
    extra: Partial<ChannelMessage> = {},
  ) => {
    const message: ChannelMessage = {
      channel: KIND,
      direction: sender.accountId === BOT ? "outbound" : "inbound",
      messageId: `m${log.length + 1}`,
      chatId: CHAT,
      senderId: sender.accountId,
      senderDisplayName: sender.name,
      text,
      attachments: [],
      timestamp: new Date((clock += 1000)),
      thread: { kind: "group", name: "Team" },
      ...extra,
    };
    log.push(message);
    return message;
  };
  const talker: Talker = {
    start(onMessage) {
      deliver = onMessage;
    },
    stop() {},
    async send(chatId, outgoing) {
      sent.push({ chatId, threadId: outgoing.threadId, text: outgoing.text ?? "" });
      const said = append({ accountId: BOT, name: "Rome" }, outgoing.text ?? "");
      return { chatId, messageId: said.messageId };
    },
    history: {
      async read(chatId, { since, until, olderThan, newerThan, limit }) {
        let said = log.filter((m) => m.chatId === chatId);
        if (olderThan !== undefined)
          said = said.slice(
            0,
            said.findIndex((m) => m.messageId === olderThan),
          );
        if (newerThan !== undefined) {
          said = said.slice(said.findIndex((m) => m.messageId === newerThan) + 1).slice(0, limit);
        }
        said = said.filter(
          (m) =>
            (!since || m.timestamp.getTime() >= since.getTime()) &&
            (!until || m.timestamp.getTime() <= until.getTime()),
        );
        return said.slice(-limit).reverse();
      },
    },
  };
  // The fields a kind declares to serve a whole workspace from one session,
  // with the Concierge on an account made for it. `servesWorkspace` is the
  // feature's own opt-in; a Rome without it ignores the field.
  const descriptor = {
    connectionKind: KIND,
    link: "own_account",
    startsWithConcierge: true,
    servesWorkspace: true,
    grant: "bot",
    auth: {
      obtain: async () => ({ material: {}, expiresAt: "never" }),
      renew: async (cred) => cred,
    },
    accountIdOf: () => BOT,
    capabilities: { talker: { reads: true, build: () => talker } },
  } as ConnectionDescriptor;
  return {
    descriptor,
    sent,
    log,
    /** Said in the group without mentioning Rome: the platform keeps it. */
    say: append,
    /** Said in the group mentioning Rome: the platform delivers it. */
    mention(sender: { accountId: string; name: string }, text: string) {
      const said = append(sender, `@Rome ${text}`);
      void deliver?.({
        id: said.messageId,
        where: { chatId: CHAT, kind: "group", name: "Team" },
        sender: { accountId: sender.accountId, name: sender.name },
        content: { text: said.text ?? "", attachments: [] },
        receivedBy: BOT,
        mentions: [BOT],
        saidAt: said.timestamp,
      });
    },
  };
}

/** Rome as index.ts wires a group mention from its connection to its reply. */
async function bootRome(db: TestDb["db"], root: string, model: FakeModel) {
  const platform = standInPlatform();
  const connectionsRepository = new DrizzleConnectionsRepository(db);
  const registry = new ConnectionRegistry({ repository: connectionsRepository });
  registry.register(platform.descriptor);
  const channelOf = (connection: { connectionKind: string }) => connection.connectionKind;
  const accounts = romeAccounts(connectionsRepository);
  const chatsWired = chatsWiring(db, {
    accountOf: (channel) => (channel === KIND ? { platform: KIND, id: BOT } : null),
    platformOfChannel: (channel) => channel,
    channelsOn: (p) => [p],
  });
  const chatEvents = new ChatEvents();
  const webchatRepo = new ChatsWebChatRepository(db, {
    chats: chatsWired.chats,
    lines: chatsWired.messages,
    links: chatsWired.links,
  });
  const people = new DrizzlePeopleRepository(db);
  await people.create({
    displayName: GUARDIAN.name,
    bondLevel: "guardian",
    links: [{ platform: KIND, id: GUARDIAN.accountId }],
  });
  const settingsRepo = new SettingsRepository(db);
  const policiesRepo = new PoliciesRepository(db);

  let recorder: ReturnType<typeof inboundRecording> | undefined;
  let builtChannels: ReturnType<typeof channelList> | undefined;
  const channels = channelList({
    db,
    whatsAppAccounts: { list: async () => [] } as never,
    linkedInAccounts: { list: async () => [] } as never,
    connections: {
      registry,
      channelOf,
      accountOf: (connectionId) => accounts.accountOf(connectionId),
      accepted: (channel, ref) => recorder?.accepted(channel, ref) ?? Promise.resolve(),
    },
  });
  builtChannels = channels;
  const channelsService = createChannelsService({
    channels: () => builtChannels,
    registry,
    channelOf,
    accounts,
  });
  const chatSettings = legacyChatIdSettings(
    new ChatSettingsService({
      repository: new ChatSettingsRepository(db, chatsWired),
      connections: registry,
      channelOf,
      channels: () => builtChannels,
      listAgents: () => ["main"],
      onChanged: () => {},
    }),
  );
  const wakeGateFor = wakeGateLoader({
    chatSettings: (chat) => chatSettings.get(chat),
    bondLevelsSetting: (key) => settingsRepo.get<string[]>(key),
    policies: () => policiesRepo.findAll(),
    connectionKindOf: (channel) => channel,
  });

  const artifactIdentity = { legacyBindings: createEmptyLegacyArtifactBindings() };
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "main.yaml"), stringifyYaml(buildAgentConfig({ name: "main" })));
  const agentLoader = new AgentLoader(artifactIdentity, ROME_AGENT_TRAITS);
  await agentLoader.loadAll(agentsDir);
  const actionRegistry = new ActionRegistryImpl();
  const approvalsRepo = new ApprovalsRepository(db);
  const actionEngine = new ActionEngine(
    actionRegistry,
    {
      executions: new ActionExecutionsRepository(db),
      approvals: approvalsRepo,
      journal: new ExecutionJournalRepository(db),
    },
    { processRole: "worker" },
  );

  const channelSurface = (channel: string) => {
    const talker = registry.getDescriptor(channel)?.capabilities.talker;
    return talker ? talkerChannelSurface(talker) : null;
  };
  const sessions = createSessions(
    {
      agentLoader,
      sessionRepository: new DrizzleSessionRepository(db),
      systemPrompts: createTestSystemPrompts(),
      modelResolver: createModelResolver({
        providers: [model],
        accounts: fakeAccounts(bothAvailable()),
      }),
      networkMcpServers: () => ({}),
      skillCatalog: new SkillLoader(artifactIdentity),
      turnLifecycle: new TurnListeners(new AppTurnHooks()),
      readAnswerShape,
      promptFacts: chatPromptFacts({
        facts: chatsWired.links,
        messages: chatsWired.messages,
        labels: chatsWired.labels,
        channelOfChat: (chatId) => webchatRepo.channelOfChat(chatId),
        channelSurface,
        latest: (place: ThreadContext, { limit, until, olderThan, newerThan }) =>
          channelsService.query(place.channel, {
            chatId: place.threadId as ChatId,
            until,
            ...(olderThan === undefined ? {} : { olderThan }),
            ...(newerThan === undefined ? {} : { newerThan }),
            limit,
          }),
      }),
      sessionTracing: romeSessionTracing,
      turnUsage: new TurnUsageReporter(),
      folders: agentFolders(),
      log: createLogger("agent-session"),
      ...romeToolPorts({ actionRegistry, actionEngine }),
    },
    { keepAliveAcrossTurns: true },
  );
  const agentRunner = new AgentRunner(
    sessions,
    agentLoader,
    webchatRepo,
    undefined,
    actionRegistry,
    { lines: chatsWired.speakerMessages, links: chatsWired.links, replies: chatsWired.replies },
    undefined,
    sessionOpeningFor({ channelSurface }),
  );

  const speakers = {
    chats: chatsWired.chats,
    adapters: chatsWired.adapters,
    speakers: chatsWired.speakers,
  };
  const repositories = createAppRuntimeRepositories({
    settingsRepo,
    webchatRepo,
    speakers,
    inChats: {
      reads: { db, reads: chatsWired.reads, webchatRepo },
      writes: {
        webchatRepo,
        chats: chatsWired.chats,
        messages: chatsWired.messages,
        speakers: chatsWired.speakers,
        replies: chatsWired.replies,
        links: chatsWired.links,
        lines: chatsWired.speakerMessages,
        adapters: chatsWired.adapters,
        channel: (name) => builtChannels?.find((channel) => channel.name === name) ?? null,
        open: (input) => openChannelChat({ records: webchatRepo, speakers }, input),
      },
    },
  });
  // An app's context as its actions use it: its repositories, and running
  // another action through the engine.
  const appContext = (appId: string) =>
    ({
      repositories,
      runAction: (name: string, args: Record<string, unknown>) =>
        actionEngine.run(name, args, { initiator: `app:${appId}`, callerAppId: appId }),
    }) as never;
  actionRegistry.register(
    createMessageHandlerAction(config("inbox:message_handler"), {
      agentRunner,
      sendGate: guardedSend,
      personMappingRepo: appPersonMapping(people, (channel) => channel),
      sentinelLogRepo: new SentinelLogRepository(db, (channel) => channel),
      approvalsRepo,
      wakeGateFor,
      resolveProfilePath: (path) => join(root, path),
      strangerPersonId: STRANGER_PERSON_ID,
      appContext: appContext("inbox"),
    } as never),
  );
  actionRegistry.register(
    createSendMessageAction(config("system:send_message"), {
      channelsService: legacyChatIdChannelsService(channelsService),
      appContext: appContext("system"),
    } as never),
  );

  const hookChannels = legacyChatIdChannels(chatsWired.recordedSends(channels)) as Channel[];
  recorder = inboundRecording(
    {
      chats: chatsWired.chats,
      messages: chatsWired.messages,
      events: chatEvents,
      adapters: chatsWired.adapters,
      hold: (messageId) => {
        chatsWired.links.wakeUndecided(messageId);
        return () => chatsWired.links.wakeDecided(messageId);
      },
    },
    hookChannels,
  );
  const hook = createHook({
    actionEngine,
    chatSettings,
    conversationSettings: chatSettings,
    chatStop: legacyChatIdStop(async () => ({ status: "nothing_running" }) as never),
    channels: hookChannels,
    messagesSaid: messagesSaid({
      chats: chatsWired.chats,
      sessions: webchatRepo,
      recording: recorder,
      events: chatEvents,
      wakes: chatsWired.links,
      labels: chatsWired.labels,
    }),
    wakeGateFor,
  } as never);
  await hook.register();

  const connection = await registry.connect(KIND);
  await registry.giveGrant(KIND, connection.id, "bot", { material: {}, expiresAt: "never" }, {});

  return {
    platform,
    settled: () => recorder?.settled() ?? Promise.resolve(),
    async stop() {
      hook.unregister();
      await sessions.shutdown();
      await actionEngine.stopWorkerWarmPool();
      await registry.stopAll?.();
    },
  };
}

const REPLY_MS = 5_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A value no model could guess. */
const fresh = () => `WORD-${randomBytes(3).toString("hex").toUpperCase()}`;

const CHATTER = [
  "morning all",
  "did anyone see the build?",
  "lunch at noon?",
  "I pushed the fix",
  "the meeting moved to 3",
  "thanks!",
  "who has the projector key?",
  "back in ten",
  "the coffee machine is fixed",
  "sounds good",
];

describe("an agent in a shared group chat", () => {
  let testDb: TestDb;
  let root: string;
  let model: FakeModel;
  let rome: Awaited<ReturnType<typeof bootRome>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "rome-ambient-"));
    rs.stubEnv("HOME", root);
    rs.stubEnv("ROME_PROFILE", `ambient-${randomUUID()}`);
    rs.stubEnv("ROME_PROJECTS_ROOT", join(root, "projects"));
    testDb = createTestDb();
    model = new FakeModel().setDefaultReply(result("I don't know."));
    rome = await bootRome(testDb.db, root, model);
  });

  afterEach(async () => {
    await rome.stop();
    testDb.close();
    rs.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Ten rounds: a member writes a fact, others write ten more messages, then
   * `asker` mentions Rome and asks for it. A round holds the fact when a send
   * after the mention, to the chat that asked, holds its value. A mention
   * left unanswered for `REPLY_MS` counts against the rounds.
   */
  async function recallRounds(asker: { accountId: string; name: string }) {
    const values = Array.from({ length: 10 }, fresh);
    // The newest value it was shown is the one it answers with, as a model
    // asked about the latest code would.
    for (const value of [...values].reverse()) {
      model
        .when((p) => p.prompt.includes(value) || p.systemPrompt.includes(value))
        .reply(result(`It is ${value}`));
    }
    const { platform } = rome;
    let held = 0;
    let answered = 0;
    for (const [round, value] of values.entries()) {
      platform.say(MEMBERS[round % MEMBERS.length], `the door code is now ${value}`);
      for (const [i, line] of CHATTER.entries())
        platform.say(MEMBERS[(round + i + 1) % MEMBERS.length], line);
      const before = platform.sent.length;
      platform.mention(asker, "what is the door code now?");
      const deadline = Date.now() + REPLY_MS;
      while (platform.sent.length === before && Date.now() < deadline) await sleep(10);
      const replies = platform.sent.slice(before).filter((s) => s.chatId === CHAT);
      if (replies.length) answered++;
      if (replies.some((s) => s.text.includes(value))) held++;
    }
    return `${held} of 10 facts held (${10 - answered} mention(s) got no reply)`;
  }

  it("recall: 10 of 10 facts held after 10 other messages each", async () => {
    expect(await recallRounds(ASKER)).toBe("10 of 10 facts held (0 mention(s) got no reply)");
  }, 120_000);

  it("recall when the guardian asks: not scored", async () => {
    expect(await recallRounds(GUARDIAN)).toBe("10 of 10 facts held (0 mention(s) got no reply)");
  }, 120_000);

  it("silence: 0 sends across 50 unmentioned messages", async () => {
    const { platform } = rome;
    for (let i = 0; i < 50; i++) {
      const sender = MEMBERS[i % MEMBERS.length];
      const earlier = platform.log.at(-1);
      switch (i % 4) {
        case 0:
          platform.say(sender, CHATTER[i % CHATTER.length]);
          break;
        case 1:
          platform.say(sender, `does anyone know where the ${i}th report went?`);
          break;
        case 2:
          platform.say(
            sender,
            "agreed",
            earlier ? { replyTo: { messageId: earlier.messageId } } : {},
          );
          break;
        default:
          platform.say(sender, "Rome would know this, I bet");
      }
    }
    await rome.settled();
    await sleep(500);
    expect(platform.sent).toHaveLength(0);
  });
});
