// The data tier of Rome's composition root. The tier, and the rule that
// composition only constructs: docs/architecture/process.md#data-tier.

import type { AppRuntimeRepositories } from "@rome-os/app-runtime";
import type { ApiDeps } from "../api/deps.js";
import { createAppRuntimeRepositories } from "../apps/repositories.js";
import { type AccountNames, createAccountNames } from "../channels/account-names.js";
import type { Channels } from "../channels/channel.js";
import { channelList } from "../channels/channel-list.js";
import type { ConnectionPortsDeps } from "../channels/connection-ports.js";
import { LinkedInAccounts } from "../channels/linkedin-accounts.js";
import type { WechatUserReader } from "../channels/wechat-user.js";
import { WhatsAppAccounts } from "../channels/whatsapp-accounts.js";
import { ConversationSettingsRepository } from "../conversation-settings/index.js";
import type { DrizzleDb } from "../db/index.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { AppKeysRepository } from "../db/repositories/app-keys.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import { ExecutionJournalRepository } from "../db/repositories/execution-journal.js";
import { LinkedInStoreRepository } from "../db/repositories/linkedin-store.js";
import { OutboxRepository } from "../db/repositories/outbox.js";
import { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { PoliciesRepository } from "../db/repositories/policies.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { WebChatRepository } from "../db/repositories/webchat.js";
import { WebhookInvocationsRepository } from "../db/repositories/webhook-invocations.js";
import { WhatsAppStoreRepository } from "../db/repositories/whatsapp-store.js";

/** Every system repository over one database handle, plus the objects built
 *  from them alone. A field that `ApiDeps` also names has the type `ApiDeps`
 *  declares, so the tier spreads into `ApiDeps`. */
export interface DataTier {
  actionExecutionsRepo: ActionExecutionsRepository;
  appKeysRepo: AppKeysRepository;
  approvalsRepo: ApprovalsRepository;
  conversationSettingsRepo: ConversationSettingsRepository;
  executionJournalRepo: ExecutionJournalRepository;
  linkedInStoreRepo: LinkedInStoreRepository;
  outboxRepo: OutboxRepository;
  personMappingRepo: PersonMappingRepository;
  policiesRepo: PoliciesRepository;
  routineRunsRepo: RoutineRunsRepository;
  routinesRepo: RoutinesRepository;
  sentinelLogRepo: SentinelLogRepository;
  sessionsRepo: SessionsRepository;
  settingsRepo: SettingsRepository;
  webchatRepo: WebChatRepository;
  webhookInvocationsRepo: WebhookInvocationsRepository;
  whatsAppStoreRepo: WhatsAppStoreRepository;
  /** The WhatsApp and LinkedIn address books behind the channel list. */
  whatsAppAccounts: WhatsAppAccounts;
  linkedInAccounts: LinkedInAccounts;
  /** The production channel list over this tier's database and address books.
   *  The caller supplies what the tier cannot hold: the Connections backing
   *  `send` and `inbound`, which exist only once every descriptor is
   *  registered, and the personal WeChat reader when that connection is on. */
  channelList(deps?: {
    connections?: ConnectionPortsDeps;
    wechatUserReader?: WechatUserReader;
  }): Channels;
  /** The account-name directory over `channels`, logging to this tier's
   *  sentinel log. */
  createAccountNames(channels: Channels): AccountNames;
  /** The repositories handed to app code. With `reactivateFloating`, the set
   *  includes the guardian-profile repository, whose write reschedules
   *  floating routines. Only the main process passes it: an action worker gets
   *  no guardian-profile repository. */
  createAppRuntimeRepositories(guardianProfile?: {
    reactivateFloating: () => Promise<void>;
  }): AppRuntimeRepositories;
}

/** Builds the data tier over `db`. Constructs only: it awaits nothing and
 *  touches neither the database nor the process environment, so boot steps
 *  that read or write through a repository run after it returns. */
export function createDataTier(db: DrizzleDb): DataTier {
  const personMappingRepo = new PersonMappingRepository(db);
  const sentinelLogRepo = new SentinelLogRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const webchatRepo = new WebChatRepository(db);
  const whatsAppStoreRepo = new WhatsAppStoreRepository(db);
  const linkedInStoreRepo = new LinkedInStoreRepository(db);
  const whatsAppAccounts = new WhatsAppAccounts(whatsAppStoreRepo);
  const linkedInAccounts = new LinkedInAccounts(linkedInStoreRepo);
  const tier: DataTier = {
    actionExecutionsRepo: new ActionExecutionsRepository(db),
    appKeysRepo: new AppKeysRepository(db),
    approvalsRepo: new ApprovalsRepository(db, undefined, personMappingRepo),
    conversationSettingsRepo: new ConversationSettingsRepository(db),
    executionJournalRepo: new ExecutionJournalRepository(db),
    linkedInStoreRepo,
    outboxRepo: new OutboxRepository(db),
    personMappingRepo,
    policiesRepo: new PoliciesRepository(db),
    routineRunsRepo: new RoutineRunsRepository(db),
    routinesRepo: new RoutinesRepository(db),
    sentinelLogRepo,
    sessionsRepo: new SessionsRepository(db),
    settingsRepo,
    webchatRepo,
    webhookInvocationsRepo: new WebhookInvocationsRepository(db),
    whatsAppStoreRepo,
    whatsAppAccounts,
    linkedInAccounts,
    channelList: (deps = {}) =>
      channelList({
        db,
        whatsAppAccounts,
        linkedInAccounts,
        ...(deps.wechatUserReader ? { wechatUserReader: deps.wechatUserReader } : {}),
        ...(deps.connections ? { connections: deps.connections } : {}),
      }),
    createAccountNames: (channels) => createAccountNames({ channels, sentinelLogRepo }),
    createAppRuntimeRepositories: (guardianProfile) =>
      createAppRuntimeRepositories({
        settingsRepo,
        webchatRepo,
        ...(guardianProfile
          ? {
              guardianProfile: { db, reactivateFloating: guardianProfile.reactivateFloating },
            }
          : {}),
      }),
  };
  return tier satisfies Pick<ApiDeps, keyof DataTier & keyof ApiDeps>;
}
