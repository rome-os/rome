import type { SystemInputSource } from "@rome/api-types/trace-segments";
import { automatedInputLabel } from "./automated-input.js";
// Concierge: texting-style chats that hand work to task chats. One Concierge
// talks in a main chat and in any topic chats its owner starts, all sharing one
// memory, one list of follows and one task list (docs/domains/chats.md#concierge-chat,
// docs/adrs/one-concierge-with-several-chats.md). Design: rome-os/rome#1344.

import type { PhoneWatching } from "../lib/phone-watching.js";
import type { DashboardActivity } from "../lib/dashboard-activity.js";
import { CONCIERGE_CHAT_ID, type ConciergeChatRef } from "@rome/api-types/concierge";
import type { Account, AgentTurnFailure, BackendTurnParams } from "@rome-os/app-runtime";
import type { MessageRepository } from "../chats/message-repository.js";
import type { Place } from "../chats/place.js";
import type { Body, SendResult } from "../chats/send.js";
import { DASHBOARD_PLATFORM } from "../webchat/dashboard-account.js";
import { webchatSessionKey } from "../core/agent-session-key.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../webchat/repository.js";
import type { ApprovalsRepository } from "../apps/repositories/approvals.js";
import type { SkillCatalog } from "../agent/index.js";
import { resolveWebchatLargeModelSelection } from "../core/model-selector.js";
import type { AgentTurnFailedBeforeStart } from "../agent/index.js";
import type { Sessions } from "../agent/index.js";
import {
  accountAllowsModel,
  CODEX_LUNA_MODEL,
  MODEL_SELECTIONS,
  sameProviderTarget,
  soleProviderAtUsageLimit,
  usageSwitchTarget,
  type ModelAccounts,
  type ModelSelectionId,
  type SessionRepository,
} from "../agent/index.js";
import { v7 as uuidv7 } from "uuid";
import { createLogger } from "../logger.js";
import type { ConciergeFollowing } from "./following.js";
import type { TaskEventCoalescer } from "./task-events.js";
import type { ConciergeActivityTracker } from "./activity.js";
import { type ConciergeTasks, stopHolds } from "./tasks.js";
import type { TaskSchedules } from "./task-schedule.js";
import { taskChatPlace } from "./task-chat.js";
import type { TaskChecks } from "./task-checks.js";
import { RESOLVED_BY_STOP, type TurnDown } from "./approval-expiry.js";
import type { NotifyLevel } from "../instance/notify-client.js";
import { ConciergePush, type ConciergePushDeps, type SaidInTurn } from "./push.js";
import { type ConciergeOwner, GUARDIAN_OWNER, ownerOf, storedChatId } from "../webchat/owner.js";
import { isMainConciergeChat, MAIN_CHAT_NAME, mainChatIdOf } from "./main-chat.js";
import type { ChatCardSettledEvent, InputsSettledEvent } from "@rome/api-types/chat";
import { openQuestionCards, settledCard, type TaskCardSources } from "./task-cards.js";
import {
  CONCIERGE_AGENT_ID,
  canOpenChat,
  isConciergeAgent,
  isConciergeChat,
  privateOwnerOf,
  TASK_CHAT_TRIGGER_KIND,
} from "../webchat/privacy.js";
import { ALL_OWNERS_SERVED, type ConciergeOwners, type OwnerProfile } from "./owners.js";

import { ambiguousQuota, type FailoverReason } from "../agent/index.js";

const log = createLogger("concierge");

/** What a digest adds about a chat's tasks, and which notes it lists. */
export interface DigestTaskNotes {
  text: string;
  /** Tasks whose scheduled run finished with nothing to say. */
  passive: string[];
  /** Tasks that ended for no response. */
  noResponse: string[];
  /** Rows a day old with no task chat started and nothing scheduled. */
  unstarted: string[];
}

/** How long a stopped task's failed approval turn-down waits to be tried again, doubling up to the most. */
const STOP_RETRY_FIRST_MS = 30_000;
const STOP_RETRY_MAX_MS = 60 * 60 * 1000;
/**
 * The scheduled runs stopped from their task chat whose approvals are still
 * to be turned down: `{ runs: [{ chatId, stoppedAt }] }`. A run's stop keeps
 * its task, so the stopped tasks the start sweep reads do not hold it.
 */
const STOPPED_RUNS_SETTING_KEY = "conciergeStoppedRuns";

/** What a stop ended: its whole task, or one scheduled run of it. */
type StopScope = "task" | "run";

interface StoppedRun {
  chatId: string;
  stoppedAt: number;
}

function parseStoppedRuns(value: unknown): StoppedRun[] {
  const runs = (value as { runs?: unknown } | null)?.runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((run) => {
    const { chatId, stoppedAt } = (run ?? {}) as Record<string, unknown>;
    return typeof chatId === "string" && typeof stoppedAt === "number"
      ? [{ chatId, stoppedAt }]
      : [];
  });
}

/** A task checked this many times and still waiting is flagged in the digest. */
export const POSTPONED_CHECKS = 3;

export { CONCIERGE_CHAT_ID };
export {
  CONCIERGE_AGENT_ID,
  canOpenChat,
  isConciergeAgent,
  isConciergeChat,
  isMainConciergeChat,
  privateOwnerOf,
  TASK_CHAT_TRIGGER_KIND,
};
/** The dashboard language the guardian picked: `en` or `zh-CN`. */
const GUARDIAN_LANGUAGE_SETTING_KEY = "guardianLanguage";
/** Concierge's own account on the dashboard, which says what it sends into a
 *  task chat. */
export const CONCIERGE_ACCOUNT: Account = { platform: DASHBOARD_PLATFORM, id: CONCIERGE_AGENT_ID };

/** How a Concierge chat was retired. */
export type RetiredHow = "archived" | "deleted";

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The line that opens every Concierge turn's input: which Concierge chat the
 * turn runs in. It rides each turn rather than the session's setup, so a
 * rename reaches a running session (rome-os/rome#1739).
 */
export function conciergeChatLine(chat: ConciergeChatRef): string {
  return `<concierge_chat id="${attr(chat.id)}" name="${attr(chat.name)}" main="${chat.main}"/>`;
}

/** The line naming the person a Concierge chat serves. */
export function conciergeOwnerLine(owner: OwnerProfile): string {
  const fields = [
    `role="${owner.role}"`,
    ...(owner.name ? [`name="${attr(owner.name)}"`] : []),
    ...(owner.email ? [`email="${attr(owner.email)}"`] : []),
  ];
  return `<concierge_owner ${fields.join(" ")}/>`;
}

/**
 * The dashboard's chat operations a task chat needs beyond saying something
 * in it: starting the chat, and its turns' state. They belong to the
 * dashboard and to Agents, not to Chats.
 */
export interface TaskChats {
  /** Starts a dashboard chat owned by `ownerKey`. */
  startChat(input: { agentName?: string; projectPath?: string }, ownerKey: string): Promise<string>;
  /**
   * Opens the runtime session of a chat that has had no turn yet, as its
   * first message would, and answers its id.
   */
  openSession(chatId: string): Promise<string>;
  isRunning(chatId: string): boolean;
  /** Whether the chat runs a turn its owner sees: any but a quiet one that has said nothing yet. */
  isBusy(chatId: string): boolean;
  /** The tool the chat's running turn is in now, as the trace names it, or null. */
  openTool(chatId: string): string | null;
  /**
   * Calls `listener` with the chat's id whenever it starts or stops running
   * a turn, or its running turn enters or leaves a tool; the latter alone
   * comes with `toolOnly`. Returns the unsubscribe.
   */
  onTurnChange(listener: (chatId: string, change: { toolOnly?: boolean }) => void): () => void;
  /** Sends `text` into the chat as the guardian's own message, the way their composer does. */
  sendAsGuardian(chatId: string, text: string): Promise<void>;
  /** Ids of the chat's turns whose streams have not ended, running or queued. */
  activeTurns(chatId: string): string[];
  interruptTurn(turnId: string): Promise<void>;
}

/** The dashboard as Concierge reaches it. The API layer builds it after
 *  Concierge, so it is attached once that layer is up. */
export interface ConciergeDashboard {
  chats: TaskChats;
  /** The ordinary send into a chat (chats/send.ts), with the dashboard able to take it. */
  send(place: Place, body: Body, as: Account): Promise<SendResult>;
}

export interface ConciergeDeps {
  skillCatalog: Pick<SkillCatalog, "find">;
  settingsRepo: Pick<SettingsRepository, "get" | "set">;
  /** Who each owner is, and whether Rome still serves them. Every owner, by role only, when left out. */
  owners?: ConciergeOwners;
  webchatRepo: Pick<
    WebChatRepository,
    | "createSession"
    | "getSession"
    | "listSessions"
    | "updateSessionName"
    | "updateSessionLargeModelSelection"
    | "getTurnChatMessages"
    | "getReplyTarget"
    | "addBackendMessage"
    | "placeInChatThread"
    | "setSessionTrigger"
    | "listProjects"
    | "onMessageInserted"
    | "awaitingGuardianSince"
    | "openWaitsOf"
    | "taskCardsOf"
    | "ownerSpokeAt"
    | "archiveSessionIn"
    | "deleteSessionIn"
    | "deleteSession"
  >;
  /** The todo list. */
  tasks: ConciergeTasks;
  /** The checks scheduled with `defer`. Absent, no task is ever later. */
  checks?: TaskChecks;
  /** Each task's repeating schedule. Absent, no task has one. */
  schedules?: TaskSchedules;
  approvals: Pick<ApprovalsRepository, "onCreated" | "onResolved">;
  messages: Pick<MessageRepository, "recent" | "before">;
  sessionRepository: Pick<SessionRepository, "current">;
  accounts: Pick<ModelAccounts, "read">;
  agentSessionManager: Pick<Sessions, "find">;
  /** Runs a system turn in a chat and waits for it to end. A quiet turn
   *  shows the guardian no sign that it runs, until the agent speaks. */
  /** Runs a backend turn; answers whether it ran to its end, when the runner says. */
  runBackendTurn: (
    params: BackendTurnParams,
    options?: SystemTurnOptions,
  ) => Promise<"completed" | "stopped" | "interrupted" | "failed" | void>;
  /** Asks Rome Cloud to push to a person's phone. Absent, nothing is pushed. */
  notify?: ConciergePushDeps["notify"];
  /** The chats each person's phone app holds open; nothing said there is pushed to them. */
  phoneWatching?: Pick<PhoneWatching, "watchersOf">;
  /** Whether each person is at a web dashboard; while they are, nothing is pushed to them. */
  dashboardActivity?: Pick<DashboardActivity, "activeOwners">;
}

/** A backend turn where it runs, with the message it answers when it reports on a task. */
/**
 * A backend turn as Rome asks for it: `taskIds`, the tasks whose news it
 * carries, as a task event's batch names them.
 */
export type TurnParams = BackendTurnParams & { taskIds?: readonly string[] };
export type ResolvedTurn = TurnParams & {
  reportedTask?: string;
  /** Where its input came from, when a check the Concierge set came due: its replies are labelled with it. */
  inputSource?: SystemInputSource;
  inputLabel?: string;
};

export interface SystemTurnOptions {
  quiet?: boolean;
  inputLabel?: string;
  /** Who sent the input, when something sent it into the chat (RunParams.inputSource). */
  inputSource?: SystemInputSource;
  /** Each message the Concierge says in the turn goes to the phone of the
   *  person the chat serves at this level. A reminder, a recovery or a notice has none. */
  pushLevel?: NotifyLevel;
  /** The tasks whose news the turn carries, as a task event's batch names them. */
  taskIds?: readonly string[];
}

/**
 * The task a `defer` wake-up is for, from the `task_id` of the `<defer_note>`
 * line Rome writes ahead of the note (routines/defer.ts). Only the first such
 * line counts: what the note itself says names nothing.
 */
/**
 * The check a `defer` wake-up is, named as Rome's headline right above its
 * `<defer_note>` line names it ("⏰ Time's up: <name>"), or null for a turn
 * that is no wake-up.
 */
function deferCheckOf(prompt: string): { name: string | null } | null {
  const lines = prompt.split("\n");
  const header = lines.findIndex((line) => line.startsWith("<defer_note "));
  if (header < 0) return null;
  const name = lines[header - 1]?.match(/^(?:⏰ Time's up|📨 Event arrived): (.+)$/u)?.[1]?.trim();
  return { name: name || null };
}

/** The source and trace label of a wake-up's turn, when the prompt is one. */
function checkSourceOf(prompt: string): { inputSource?: SystemInputSource; inputLabel?: string } {
  const check = deferCheckOf(prompt);
  if (!check) return {};
  const inputSource: SystemInputSource = { type: "check", name: check.name };
  return { inputSource, inputLabel: automatedInputLabel(inputSource) };
}

function deferTaskIds(prompt: string): string[] {
  const header = prompt.match(/^<defer_note [^\n]*$/m)?.[0];
  const id = header?.match(/\btask_id="([^"]+)"/)?.[1];
  return id ? [id.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&amp;", "&")] : [];
}

export class ConciergeService {
  private readonly leftModels = new Map<string, number>();
  /** The main chat being created, per owner, so concurrent calls share one. */
  private readonly creating = new Map<ConciergeOwner, Promise<string>>();
  private attached: ConciergeDashboard | null = null;
  private failedStarts = new Map<string, { turnId: string; starts: Map<string, string> }>();
  private approvalExpiry: ((chatId: string, turnDown: TurnDown) => Promise<number>) | null = null;
  private taskEvents: TaskEventCoalescer | null = null;
  private readonly cardListeners = new Set<(event: ChatCardSettledEvent) => void>();
  private readonly inputListeners = new Set<(event: InputsSettledEvent) => void>();
  /** Per Concierge chat, the task whose report a newer input took over. */
  private readonly carriedReports = new Map<string, readonly string[]>();
  /** Per Concierge chat, the guardian messages superseded turns handed on. */
  private readonly handedOnPrompts = new Map<string, string[]>();
  /** What each Concierge turn said, by its parts, task and answered messages: a repeat is the same message. */
  private readonly saidByKey = new Map<string, Map<string, string>>();
  private failedBeforeStart: ((event: AgentTurnFailedBeforeStart) => void) | null = null;
  private attachedFollowing: ConciergeFollowing | null = null;
  private readonly push: ConciergePush | null;

  constructor(readonly deps: ConciergeDeps) {
    this.push = deps.notify
      ? new ConciergePush({
          notify: deps.notify,
          ownerOf: (chatId) => this.ownerOfChat(chatId),
          quietUntil: async (at, owner) =>
            (await this.attachedFollowing?.quietUntil(at, owner)) ?? null,
          watchersOf: (chatId) => deps.phoneWatching?.watchersOf(chatId) ?? new Set(),
          activeOwners: () => deps.dashboardActivity?.activeOwners() ?? new Set(),
          // A visitor has no language setting of their own; the dashboard's is the guardian's.
          language: async () => {
            const stored = await this.deps.settingsRepo.get(GUARDIAN_LANGUAGE_SETTING_KEY);
            return typeof stored === "string" ? stored : null;
          },
        })
      : null;
  }

  /**
   * The Concierge said something in a chat. A message of a turn with a push
   * level also goes to the phone of the person the chat serves, the guardian
   * or a visitor, by the rules of {@link ConciergePush}.
   */
  said(said: SaidInTurn): void {
    this.push?.said(said);
  }

  attachDashboard(dashboard: ConciergeDashboard): void {
    this.attached = dashboard;
    for (const watcher of this.turnWatchers) {
      watcher.stop = dashboard.chats.onTurnChange(watcher.listener);
    }
  }

  private turnWatchers = new Set<{
    listener: (chatId: string, change: { toolOnly?: boolean }) => void;
    stop: (() => void) | null;
  }>();

  /**
   * Calls `listener` whenever a chat's turn changes, as
   * `TaskChats.onTurnChange` says, from when the dashboard is attached, which
   * may be after this call. Returns the unsubscribe.
   */
  watchTurns(listener: (chatId: string, change: { toolOnly?: boolean }) => void): () => void {
    const watcher = {
      listener,
      stop: this.attached ? this.attached.chats.onTurnChange(listener) : null,
    };
    this.turnWatchers.add(watcher);
    return () => {
      watcher.stop?.();
      this.turnWatchers.delete(watcher);
    };
  }

  private attachedActivity: ConciergeActivityTracker | null = null;

  /** What each Concierge chat is doing, for its header; null until the events are started. */
  get activity(): ConciergeActivityTracker | null {
    return this.attachedActivity;
  }

  attachActivity(activity: ConciergeActivityTracker | null): void {
    this.attachedActivity = activity;
  }

  /** The dashboard. Throws before the API layer has attached it, which no
   *  turn can outrun, since turns start from that layer. */
  get dashboard(): ConciergeDashboard {
    if (!this.attached) throw new Error("The dashboard is not up yet");
    return this.attached;
  }

  /** An owner's main Concierge chat's id, or null when it does not exist yet. */
  async findChatId(owner: ConciergeOwner = GUARDIAN_OWNER): Promise<string | null> {
    const id = mainChatIdOf(owner);
    return (await this.deps.webchatRepo.getSession(id)) ? id : null;
  }

  /**
   * An owner's main Concierge chat's id. Creates the chat on first use, for a
   * visitor when they first open the Concierge; concurrent calls share one
   * creation. The initial model is picked here; later selections and quota
   * failover are stored on the chat. A chat created before any provider was
   * signed in has no model, so it gets one the first time a provider is
   * available.
   */
  async ensureChatId(owner: ConciergeOwner = GUARDIAN_OWNER): Promise<string> {
    const id = mainChatIdOf(owner);
    const existing = await this.deps.webchatRepo.getSession(id);
    if (existing) {
      if (!existing.largeModelSelection) {
        const picked = this.pickModel();
        if (picked) await this.deps.webchatRepo.updateSessionLargeModelSelection(id, picked);
      }
      return id;
    }
    let creating = this.creating.get(owner);
    if (!creating) {
      creating = this.createChat(owner).finally(() => this.creating.delete(owner));
      this.creating.set(owner, creating);
    }
    return await creating;
  }

  private async createChat(owner: ConciergeOwner): Promise<string> {
    const id = mainChatIdOf(owner);
    await this.deps.webchatRepo.createSession(
      id,
      MAIN_CHAT_NAME,
      undefined,
      undefined,
      this.pickModel(),
      undefined,
      CONCIERGE_AGENT_ID,
      "webchat",
      null,
      // The guardian's chat keeps no owner, as before; a visitor's names them.
      owner === GUARDIAN_OWNER ? {} : { ownerKey: owner },
    );
    log.info("concierge chat created", { chatId: id });
    return id;
  }

  /**
   * The guardian's first sign-in: makes sure their main chat exists. With a
   * `message`, it goes into that chat as the guardian's own, the way the
   * composer sends it, and the Concierge answers it as any other. Answers the
   * main chat's id. The message is not awaited, and a failure to send it (no
   * model signed in yet) is logged, so the sign-in that calls this never fails
   * on it.
   */
  async startMainChat(message: string | null): Promise<string> {
    const chatId = await this.ensureChatId();
    if (message) {
      this.dashboard.chats.sendAsGuardian(chatId, message).catch((error: unknown) =>
        log.warn("first message to the Concierge was not sent", {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return chatId;
  }

  /**
   * The guardian connected `service` from a connect card in `chatId`: tells the
   * Concierge there, quietly, so it goes on without the guardian typing. Not
   * awaited; a failure is logged.
   */
  serviceConnected(chatId: string, service: string): void {
    this.runSystemTurn(chatId, `<service_connected service="${attr(service)}"/>`, {
      quiet: true,
      inputLabel: "Service connected",
    }).catch((error: unknown) =>
      log.warn("service connected notice failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /** Who each owner is, and whether Rome still serves them. */
  get owners(): ConciergeOwners {
    return this.deps.owners ?? ALL_OWNERS_SERVED;
  }

  /** Whether Rome serves `owner`'s Concierge now: the guardian always, a visitor while on the dashboard allow-list. */
  isServed(owner: ConciergeOwner): Promise<boolean> {
    return this.owners.isServed(owner);
  }

  /**
   * What every turn in a Concierge chat opens with: the chat it runs in, and
   * the person it serves, who may not be the guardian.
   */
  async turnHeader(chat: ConciergeChatRef): Promise<string> {
    // A chat whose owner cannot be found serves no one: never the guardian by default.
    const ownerKey = await this.ownerOfChat(chat.id);
    if (ownerKey === null) throw new Error(`No Concierge chat ${chat.id}`);
    const owner = await this.owners.profileOf(ownerKey);
    return `${conciergeChatLine(chat)}\n${conciergeOwnerLine(owner)}`;
  }

  /** Whether a chat is its owner's main Concierge chat. */
  isMainChat(chat: { id: string; ownerKey?: string | null }): boolean {
    return chat.id === mainChatIdOf(ownerOf(chat));
  }

  /**
   * Whose Concierge a chat is: the owner it records. No chat, and the
   * guardian's main chat's id, name the guardian. Null for a chat that no
   * longer exists, whose owner only what still names it can tell.
   */
  async ownerOfChat(chatId: string | null | undefined): Promise<ConciergeOwner | null> {
    if (!chatId || chatId === CONCIERGE_CHAT_ID) return GUARDIAN_OWNER;
    const chat = await this.deps.webchatRepo.getSession(chatId);
    return chat ? ownerOf(chat) : null;
  }

  /** A Concierge chat that is not archived, as a list shows it, or null. */
  async conciergeChat(chatId: string): Promise<ConciergeChatRef | null> {
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (!chat || !isConciergeChat(chat) || chat.archivedAt) return null;
    return { id: chat.id, name: chat.name, main: this.isMainChat(chat) };
  }

  /**
   * Where something that reports to Concierge chat `chatId` goes: that chat
   * while it is a live Concierge chat, else the main chat of `owner`, the
   * owner the thing itself records, so a chat that is gone never sends it to
   * another owner's chat. Answers null only while that main chat does not
   * exist.
   */
  async deliveryChat(
    chatId: string | null | undefined,
    owner: ConciergeOwner,
  ): Promise<string | null> {
    if (chatId && (await this.conciergeChat(chatId))) return chatId;
    return this.findChatId(owner);
  }

  /** An owner's Concierge chats: the main chat first, then the topic chats, oldest first. */
  async listChats(owner: ConciergeOwner = GUARDIAN_OWNER): Promise<ConciergeChatRef[]> {
    const main = await this.conciergeChat(await this.ensureChatId(owner));
    const topics = (await this.deps.webchatRepo.listSessions("active", owner))
      .filter((chat) => isConciergeChat(chat) && !this.isMainChat(chat))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((chat) => ({ id: chat.id, name: chat.name, main: false }));
    return [...(main ? [main] : []), ...topics];
  }

  /**
   * Starts a topic chat of `owner` on the model their main chat uses, and
   * answers it. With no name it is untitled (an empty name), and its first
   * message names it.
   */
  async startTopicChat(owner: ConciergeOwner, name?: string): Promise<ConciergeChatRef> {
    const trimmed = name?.trim() ?? "";
    if (name !== undefined && !trimmed) throw new Error("A topic chat needs a name");
    const main = await this.deps.webchatRepo.getSession(await this.ensureChatId(owner));
    const id = uuidv7();
    await this.deps.webchatRepo.createSession(
      id,
      trimmed,
      undefined,
      undefined,
      main?.largeModelSelection ?? this.pickModel(),
      undefined,
      CONCIERGE_AGENT_ID,
      "webchat",
      null,
      { ownerKey: owner },
    );
    log.info("concierge topic chat started", { chatId: id });
    return { id, name: trimmed, main: false };
  }

  /**
   * A Concierge chat is being archived or deleted. Its follows, its unfinished
   * tasks and the events owed to it move to its owner's main chat, and the
   * Concierge says so there. A main chat is never retired: this throws for one.
   * Answers the main chat the chat's work moved to, or null when it is no
   * Concierge chat. After a delete, call `chatGone` once the chat is gone.
   */
  async retireChat(chatId: string, how: RetiredHow): Promise<string | null> {
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (chatId === CONCIERGE_CHAT_ID || (chat && this.isMainChat(chat)))
      throw new Error("The main Concierge chat cannot be archived or deleted");
    if (!chat || !isConciergeChat(chat)) return null;
    const owner = ownerOf(chat);
    const main = await this.ensureChatId(owner);
    const follows = (await this.attachedFollowing?.moveToMainChat(chatId, storedChatId(main))) ?? 0;
    // Its rows are its owner's main chat's from now on, as rows are read:
    // none is moved. Open ones start a new thread there.
    const tasks = await this.deps.tasks.repo.leaveChat(
      chatId,
      async (rows) => {
        const status = await this.deps.tasks.statusOf(rows);
        return new Set(
          rows.filter((row) => status.get(row.id)?.status !== "ended").map((row) => row.id),
        );
      },
      { deleted: how === "deleted" },
    );
    log.info("concierge chat retired", { chatId, how, follows, tasks });
    // A deleted chat is still there now: its caller tells the activity once
    // it is gone, so finished rows read as the main chat's by then.
    if (how === "archived") await this.chatGone(chatId, main);
    if (follows === 0 && tasks === 0) return main;
    void this.runSystemTurn(
      main,
      `<concierge_chat_retired name="${attr(chat.name)}" how="${how}" follows="${follows}" tasks="${tasks}"/>`,
      { quiet: true, inputLabel: "Concierge chat retired" },
    ).catch((error: unknown) =>
      log.warn("retired chat notice failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return main;
  }

  /**
   * A retired Concierge chat is archived or deleted now, and its tasks are
   * `mainChatId`'s. A deleted one's status reactions go with it. Finished rows stay on the retired chat, so no row write
   * tells the activity that their task chats now move the main chat.
   */
  async chatGone(chatId: string, mainChatId: string, deleted = false): Promise<void> {
    // A deleted chat's messages are gone, and their marks with them.
    if (deleted) {
      await this.deps.tasks.repo.forgetMessages(chatId).catch((error: unknown) =>
        log.warn("failed to forget a deleted chat's status reactions", {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    await this.activity?.retired(chatId, mainChatId).catch((error: unknown) =>
      log.warn("concierge activity retire failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // The YAML tier prefers Codex whenever it is signed in, so the choice is
  // stored on the chat: Sonnet answers fastest and calls tools most reliably,
  // and Codex's small model is next. An Anthropic-compatible provider serves
  // its own models through the tier mappings, so it keeps the tier's choice,
  // as does a chat that neither provider can serve.
  private pickModel(): ModelSelectionId | null {
    const { anthropic: claude, openai: codex } = this.deps.accounts.read();
    if (claude?.state === "available" && claude.account.authMethod !== "stored-compatible") {
      return "claude-sonnet";
    }
    if (codex?.state === "available") {
      return accountAllowsModel(codex.account, CODEX_LUNA_MODEL) ? "gpt-6-luna" : "gpt-5-6-terra";
    }
    return null;
  }

  /** Checks raw subscription availability before a turn in any Concierge chat. */
  async switchIfExhausted(chatId: string) {
    return this.move(chatId);
  }

  async switchForFailure(
    chatId: string,
    failure: AgentTurnFailure,
    reason: FailoverReason,
    crossOnly = false,
  ) {
    return this.move(chatId, failure, reason, crossOnly);
  }

  private async move(
    chatId: string,
    failure?: AgentTurnFailure,
    reason?: FailoverReason,
    crossOnly = false,
  ) {
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (!chat || !isConciergeChat(chat)) return null;
    const key = { agentName: CONCIERGE_AGENT_ID, channelThreadKey: webchatSessionKey(chatId) };
    const selected = resolveWebchatLargeModelSelection(chat.largeModelSelection);
    const runtime = selected
      ? null
      : await this.deps.sessionRepository.current(key.channelThreadKey, key.agentName);
    const state = this.deps.accounts.read();
    // An Auto chat whose first turn failed has no recorded provider yet.
    const from =
      selected?.providerId ??
      runtime?.provider ??
      failure?.provider ??
      soleProviderAtUsageLimit(state);
    if (from !== "openai" && from !== "anthropic") return null;
    if (failure && failure.provider !== from) return null;
    const source = state[from];
    // An account billed per use has no subscription to switch from.
    if (source?.account.usageLimited === false) return null;
    reason ??=
      source?.state === "usage_limit_reached"
        ? "quota"
        : // Codex runs on Rome credits while the ChatGPT account is out, so that alone is no failure.
          (from === "anthropic" && source?.state === "unauthorized") || source?.state === "expired"
          ? "login"
          : undefined;
    if (!reason) return null;
    const fromModel = selected?.model ?? runtime?.model ?? "";
    const same =
      !crossOnly &&
      (reason === "model_limit" || (reason === "quota" && ambiguousQuota(failure?.message ?? "")))
        ? sameProviderTarget(state, from, fromModel)
        : null;
    const cross = usageSwitchTarget(state, from, true);
    const candidates = reason === "model_limit" ? [same, cross] : [cross, same];
    // A model each Concierge chat left, so one chat's move never blocks another's.
    const modelKey = (model: string) => `${chatId}\u0000${model.replace(/\[.*\]$/, "")}`;
    const target = candidates.find(
      (candidate) =>
        candidate &&
        (this.leftModels.get(modelKey(MODEL_SELECTIONS[candidate.selectionId].model)) ?? 0) <=
          Date.now(),
    );
    if (!target) return null;
    await this.deps.webchatRepo.updateSessionLargeModelSelection(chatId, target.selectionId);
    this.deps.agentSessionManager.find(key)?.selectModel(target.selectionId);
    this.leftModels.set(modelKey(fromModel), Date.now() + 10 * 60_000);
    await this.deps.webchatRepo.addBackendMessage(chatId, uuidv7(), [
      {
        type: "quota_switch",
        from,
        to: target.provider,
        reason,
        fromModel,
        model: MODEL_SELECTIONS[target.selectionId].model,
      },
    ]);
    return { from, to: target.provider, selectionId: target.selectionId, reason };
  }

  /** The runtime session id of a Concierge chat, or null before its first turn. */
  async runtimeSessionId(chatId: string): Promise<string | null> {
    const stored = await this.deps.sessionRepository.current(
      webchatSessionKey(chatId),
      CONCIERGE_AGENT_ID,
    );
    return stored?.id ?? null;
  }

  /**
   * Where a Concierge turn runs, decided when it is sent: the chat it names
   * while that is a live Concierge chat, else the main chat. A chat that never
   * had a turn gets its runtime first, after the same quota check a send makes.
   * The turn's input opens with the line naming the chat. Every backend turn
   * passes here (alerts, digests, task events, recoveries and the wake-ups of
   * `defer`), so a turn never lands in a chat the guardian closed.
   */
  async resolveTurn(params: TurnParams): Promise<ResolvedTurn> {
    if (params.channel !== "webchat" || !isConciergeAgent(params.agentName)) return params;
    // The owner a wake-up recorded when it was scheduled, else its chat's.
    // With neither, its chat is gone and nothing says whose it was: it is
    // dropped, never sent to another person's chat.
    const owner = params.ownerKey ?? (await this.ownerOfChat(params.threadId));
    if (owner === null) {
      log.warn("Concierge turn dropped: its chat is gone and it records no owner", {
        chatId: params.threadId,
      });
      throw new Error(`No Concierge chat ${params.threadId}, and no owner to send its turn to`);
    }
    // Before the main chat exists, the turn stays where it was sent.
    const chatId = (await this.deliveryChat(params.threadId, owner)) ?? params.threadId;
    // A turn is bound to its chat, not to the runtime session that asked for
    // it: a wake-up of `defer` set in a session since renewed wakes the chat's
    // current one, and its note carries what it needs.
    const sessionId = (await this.runtimeOf(chatId)) || params.sessionId;
    const chat = await this.conciergeChat(chatId);
    const opening = [
      chat && !params.prompt.startsWith("<concierge_chat ") ? await this.turnHeader(chat) : "",
      chat ? await this.stoppedRequestLines(chatId) : "",
    ].filter(Boolean);
    const prompt = opening.length > 0 ? `${opening.join("\n")}\n\n${params.prompt}` : params.prompt;
    const reportedTask = await this.reportedTaskOf(this.taskIdsOf(params), chatId);
    return {
      ...params,
      threadId: chatId,
      sessionId,
      prompt,
      ...(reportedTask ? { reportedTask } : {}),
      // A check that came due: the Concierge speaks on its own, and its
      // replies say which check woke it.
      ...checkSourceOf(params.prompt),
    };
  }

  /**
   * The tasks a turn is about, from what it was started with: a task event's
   * batch, or a `defer` wake-up's task. Never read from the text it carries,
   * where a stray name could stand for another task.
   */
  private taskIdsOf(params: TurnParams): readonly string[] {
    return params.taskIds ?? deferTaskIds(params.prompt);
  }

  /** The tasks of `taskIds` that are `chatId`'s rows. */
  private async ownTasks(taskIds: readonly string[], chatId: string): Promise<string[]> {
    const own: string[] = [];
    for (const id of taskIds) {
      const found = await this.deps.tasks.repo.getWithChat(id);
      if (found && found.conciergeChat.id === chatId) own.push(found.row.id);
    }
    return own;
  }

  /**
   * The one task row a turn reports on: the row it was started about, when
   * it is `chatId`'s. A turn about several rows reports on none that a line
   * can be filed under.
   */
  private async reportedTaskOf(
    taskIds: readonly string[],
    chatId: string,
  ): Promise<string | undefined> {
    // Which of several tasks a line reports on is not ours to guess.
    if (new Set(taskIds).size !== 1) return undefined;
    const [own] = await this.ownTasks(taskIds, chatId);
    return own;
  }

  /**
   * A Concierge chat's runtime session, opened when it has none yet, as its
   * first message would open it: on a provider the quota check left it, read
   * again after that check.
   */
  private async runtimeOf(chatId: string): Promise<string | null> {
    const existing = await this.runtimeSessionId(chatId);
    if (existing || !this.attached) return existing;
    await this.switchIfExhausted(chatId);
    return this.attached.chats.openSession(chatId);
  }

  /**
   * Runs `prompt` as a system turn in a Concierge chat, or in the main chat
   * when that chat is archived or gone. Answers whether a turn ran to its end:
   * false when no runtime could be found or opened, and when the turn errored
   * or was stopped.
   */
  async runSystemTurn(
    chatId: string,
    prompt: string,
    options: SystemTurnOptions = {},
  ): Promise<boolean> {
    return (await this.systemTurnOutcome(chatId, prompt, options)) === "completed";
  }

  /** {@link runSystemTurn}, telling a turn cut short by a Stop or a newer message from one that failed. */
  async systemTurnOutcome(
    chatId: string,
    prompt: string,
    options: SystemTurnOptions = {},
  ): Promise<"completed" | "stopped" | "interrupted" | "failed"> {
    const params = await this.resolveTurn({
      agentName: CONCIERGE_AGENT_ID,
      sessionId: "",
      channel: "webchat",
      threadId: chatId,
      prompt,
      ...(options.taskIds ? { taskIds: options.taskIds } : {}),
    });
    if (!params.sessionId) return "failed";
    const outcome = (await this.deps.runBackendTurn(params, options)) ?? "failed";
    // A newer input took a report over before the Concierge said it: the
    // turn that took over also carries every task's news it held, one task's
    // or a batch's.
    if (outcome === "interrupted") {
      const carried = await this.ownTasks(this.taskIdsOf(params), params.threadId);
      if (carried.length > 0) this.carriedReports.set(params.threadId, carried);
    }
    // The tasks it reported on settle with the flush that carried them: the
    // coalescer settles exactly the news a completed turn carried
    // (docs/domains/chats.md#status-reaction).
    return outcome;
  }

  /**
   * Task `taskId`'s result was said, as by `say` naming it. Saying it settles
   * nothing: the news stays until a report that carried it runs to its end.
   * Only a Stop of that report turn reads it, so the result is not shown as
   * never told.
   */
  noteSaid(taskId: string): void {
    this.taskEvents?.said(taskId);
  }

  /** The message Concierge turn `turnId` said as `key` already, if it did. */
  saidInTurn(turnId: string, key: string): string | undefined {
    return this.saidByKey.get(turnId)?.get(key);
  }

  /** Concierge turn `turnId` said message `id` as `key`; forgotten once the turn ends. */
  keepSaid(turnId: string, key: string, id: string): void {
    const said = this.saidByKey.get(turnId) ?? new Map<string, string>();
    said.set(key, id);
    this.saidByKey.set(turnId, said);
  }

  /** Forgets what Concierge turn `turnId` said, once it ended. */
  forgetTurn(turnId: string): void {
    this.saidByKey.delete(turnId);
  }

  /**
   * The tasks whose report a newer input took over in Concierge chat
   * `chatId`, until the turn that took it over ends. That turn is about the
   * owner's message and these tasks, so what it says names its subject
   * (docs/domains/chats.md#chat-thread).
   */
  carriedReport(chatId: string): readonly string[] | undefined {
    return this.carriedReports.get(chatId);
  }

  /** Whether a running Concierge turn took over a cut-short report that holds task `taskId`'s news. */
  carriesReport(taskId: string): boolean {
    for (const tasks of this.carriedReports.values()) if (tasks.includes(taskId)) return true;
    return false;
  }

  /** A Concierge turn in `chatId` ended without handing its work on. */
  turnSettled(chatId: string): void {
    this.carriedReports.delete(chatId);
    this.handedOnPrompts.delete(chatId);
  }

  /**
   * A newer input took a Concierge turn in `chatId` over before it finished:
   * the guardian messages it took are the next turn's too, until a turn there
   * ends without handing its work on.
   */
  handOnPrompts(chatId: string, messageIds: readonly string[]): void {
    const held = this.handedOnPrompts.get(chatId) ?? [];
    this.handedOnPrompts.set(chatId, [...new Set([...held, ...messageIds])]);
  }

  /** The guardian messages earlier turns in `chatId` handed on to the running one. */
  promptsHandedOn(chatId: string): readonly string[] {
    return this.handedOnPrompts.get(chatId) ?? [];
  }

  /** The delivery of task-chat changes, once {@link startConciergeEvents} has started it. */
  /**
   * Calls `listener` with the owner's messages a Concierge turn took in once
   * that turn ended and nothing carries them on. Returns the unsubscribe.
   */
  onInputsSettled(listener: (event: InputsSettledEvent) => void): () => void {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  /** The turn that took messages `inputIds` of Concierge chat `chatId` in ended. */
  inputsSettled(chatId: string, inputIds: readonly string[]): void {
    if (inputIds.length === 0) return;
    for (const listener of this.inputListeners)
      listener({ sessionId: chatId, inputIds: [...inputIds] });
  }

  /** Calls `listener` whenever a card a task card shows settles. Returns the unsubscribe. */
  onCardSettled(listener: (event: ChatCardSettledEvent) => void): () => void {
    this.cardListeners.add(listener);
    return () => {
      this.cardListeners.delete(listener);
    };
  }

  /**
   * A question or approval of task chat `chatId` settled: answered,
   * dismissed, decided, turned down, or out of time (`openQuestions`, as a
   * wait's expiry ends every one still open). The Concierge chats its task
   * reports to hear it as it reads now. Every settle comes through here.
   */
  async cardSettled(
    chatId: string,
    item: { kind: "question" | "approval"; id: string } | "openQuestions",
  ): Promise<void> {
    if (this.cardListeners.size === 0) return;
    const row = await this.deps.tasks.repo.findBySession(chatId);
    if (!row) return;
    const found = await this.deps.tasks.repo.getWithChat(row.id);
    // The chat it reports to now, and the one it was said in, if it moved since.
    const chats = new Set([found?.conciergeChat.id, row.chatId]);
    const sources = this.taskCardSources();
    const cards =
      item === "openQuestions"
        ? await openQuestionCards(sources, chatId)
        : [await settledCard(sources, chatId, item)].filter((card) => card !== null);
    for (const card of cards) {
      for (const sessionId of chats) {
        if (!sessionId) continue;
        for (const listener of this.cardListeners) listener({ sessionId, card });
      }
    }
  }

  /** Where task cards read what they show (task-cards.ts). */
  taskCardSources(): TaskCardSources {
    return {
      taskCardsOf: (chatIds) => this.deps.webchatRepo.taskCardsOf(chatIds),
      findBySessions: (chatIds) => this.deps.tasks.repo.findBySessions(chatIds),
      waitExpiry: this.deps.tasks.waitExpiry,
    };
  }

  attachTaskEvents(events: TaskEventCoalescer | null): void {
    this.taskEvents = events;
  }

  /** What the Concierge follows, once {@link startConciergeFollowing} has started it. */
  attachFollowing(following: ConciergeFollowing | null): void {
    this.attachedFollowing = following;
  }

  get following(): ConciergeFollowing {
    if (!this.attachedFollowing) throw new Error("Following is not running");
    return this.attachedFollowing;
  }

  /**
   * Archives or deletes dashboard chat `chatId`. A task chat's task stops
   * with it: its running work is interrupted, and its row is stopped and
   * archived in the same transaction as the chat (docs/domains/chats.md#task-chat).
   * Answers the row's id, or null when the chat links no row of its owner.
   */
  async endTaskChat(chatId: string, end: "archived" | "deleted"): Promise<string | null> {
    const chat = await this.deps.webchatRepo.getSession(chatId);
    const { webchatRepo } = this.deps;
    // A chat already gone has no row of its owner to end: the write still runs.
    if (!chat) {
      if (end === "deleted") await webchatRepo.deleteSession(chatId);
      return null;
    }
    // Nothing approved later runs for a task that ends with its chat. Only
    // a task still open stops: one that ended keeps how it ended.
    const linked = await this.deps.tasks.repo.findBySession(chatId);
    const owned = linked && ownerOf(linked) === ownerOf(chat) ? linked : null;
    // Read before the turn-down: a task waiting on an approval is open, and
    // turning the approval down would make it read ended.
    const open = owned
      ? (await this.deps.tasks.statusOf([owned], { asReported: true })).get(owned.id)?.status !==
        "ended"
      : false;
    const row = await this.deps.tasks.repo.endWithChat(
      chatId,
      ownerOf(chat),
      end,
      (tx) =>
        end === "archived"
          ? webchatRepo.archiveSessionIn(tx, chatId)
          : webchatRepo.deleteSessionIn(tx, chatId),
      new Date(),
      open,
    );
    // A task that ends with its chat has nothing left to check on.
    if (row) await this.cancelChecks(row.id);
    if (row && end === "archived" && this.attached) {
      const { chats } = this.attached;
      for (const turnId of chats.activeTurns(chatId)) {
        await chats.interruptTurn(turnId).catch((error: unknown) =>
          log.warn("failed to stop an archived task chat's turn", {
            chatId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    // Turned down once its work has stopped, so one its turn asked for while
    // stopping is too.
    if (owned) await this.turnDownForStop(chatId, Date.now());
    return row?.id ?? null;
  }

  /**
   * The task that failed to start in Concierge chat `chatId`'s turn `turnId`
   * as `key` (its title, or the row it linked), or null. A retry of that
   * start in the same turn makes no second task.
   */
  failedStart(chatId: string, turnId: string, key: string): string | null {
    const failed = this.failedStarts.get(chatId);
    return failed?.turnId === turnId ? (failed.starts.get(key) ?? null) : null;
  }

  /** Task `taskId` failed to start as `key` in Concierge chat `chatId`'s turn `turnId`. Only that turn's are kept. */
  noteFailedStart(chatId: string, turnId: string, key: string, taskId: string): void {
    const failed = this.failedStarts.get(chatId);
    if (failed?.turnId === turnId) failed.starts.set(key, taskId);
    else this.failedStarts.set(chatId, { turnId, starts: new Map([[key, taskId]]) });
  }

  /**
   * The lines that tell a Concierge turn in chat `chatId` which of its
   * owner's messages they stopped before an answer, so the turn does not
   * act on them unless asked again (rome-os/rome#2044). Told once. Empty
   * when there are none.
   */
  async stoppedRequestLines(chatId: string): Promise<string> {
    // Only a hint for the turn: a failure to read them never holds a turn up.
    const stopped = await Promise.resolve()
      .then(() => this.deps.tasks.repo.takeStoppedRequests(chatId))
      .catch((error: unknown) => {
        log.warn("failed to read stopped requests", {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as string[];
      });
    return stopped.map((key) => `<stopped_request message_id="${attr(key)}"/>`).join("\n");
  }

  /**
   * What a digest of Concierge chat `chatId` adds about its tasks: each task
   * still waiting on a check it scheduled `POSTPONED_CHECKS` times or more,
   * so the Concierge asks the guardian rather than check again, each
   * scheduled run that finished with nothing to say, each task that ended
   * for no response, and each row left a day with no task chat started and
   * nothing scheduled, so the Concierge asks the guardian about it. Each of
   * the last two is listed once. `text` is empty when there is nothing to say.
   * Read only: {@link markTaskNotesListed} settles them once the digest's
   * turn ran to its end, so a failed digest leaves them for the next one.
   */
  async digestTaskNotes(chatId: string, owner: ConciergeOwner): Promise<DigestTaskNotes> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = (await this.deps.tasks.repo.listForConciergeChat(chatId, owner, since)).map(
      (task) => task.row,
    );
    const ids = rows.map((row) => row.id);
    const status = await this.deps.tasks.statusOf(rows);
    const later = rows.filter((row) => status.get(row.id)?.status === "later");
    const counts =
      (await this.deps.checks?.timesScheduled(later.map((row) => row.id))) ?? new Map();
    const lines = later.flatMap((row) => {
      const checks = counts.get(row.id) ?? 0;
      return checks >= POSTPONED_CHECKS
        ? [
            `<check_postponed task="${attr(row.id)}" title="${attr(row.title)}" checks="${checks}"/>`,
          ]
        : [];
    });
    // A scheduled run that finished with nothing to say goes here, not in a turn of its own.
    const passive = this.taskEvents?.passiveOf(ids) ?? [];
    for (const row of rows) {
      if (passive.includes(row.id)) {
        lines.push(`<ran_on_schedule task="${attr(row.id)}" title="${attr(row.title)}"/>`);
      }
    }
    // Each task that ended for no response is listed once, so it can be resumed.
    const noResponse = await this.deps.tasks.repo.noResponseUnlisted(ids);
    for (const row of rows) {
      if (noResponse.includes(row.id)) {
        lines.push(`<ended_no_response task="${attr(row.id)}" title="${attr(row.title)}"/>`);
      }
    }
    // A row the Concierge wrote and never started stays later: after a day
    // with nothing scheduled, the guardian is asked about it, once.
    const dayAgo = Date.now() - this.deps.tasks.waitExpiry;
    const unstarted = later
      .filter(
        (row) =>
          !row.linkedAt &&
          !row.sessionId &&
          !row.lastOutcome &&
          !row.unstartedListedAt &&
          status.get(row.id)?.laterAt === null &&
          row.updatedAt.getTime() <= dayAgo,
      )
      .map((row) => row.id);
    for (const row of rows) {
      if (unstarted.includes(row.id)) {
        lines.push(`<not_started task="${attr(row.id)}" title="${attr(row.title)}"/>`);
      }
    }
    return {
      text: lines.length > 0 ? `<task_review>\n${lines.join("\n")}\n</task_review>` : "",
      passive,
      noResponse,
      unstarted,
    };
  }

  /** Settles the notes a digest listed, once its turn ran to its end. */
  async markTaskNotesListed(notes: DigestTaskNotes): Promise<void> {
    this.taskEvents?.settlePassive(notes.passive);
    await this.deps.tasks.repo.markNoResponseListed(notes.noResponse);
    await this.deps.tasks.repo.markUnstartedListed(notes.unstarted);
  }

  /**
   * Stops task `taskId`, as `by` asked: it ends stopped, its task chat's
   * running work stops, and its checks are cancelled. A stop by its owner is
   * told to the Concierge quietly. Answers how many turns it stopped.
   */
  async stopTask(taskId: string, by: "concierge" | "guardian"): Promise<number> {
    await this.deps.tasks.repo.stop(taskId, by);
    await this.cancelChecks(taskId);
    if (by === "guardian")
      this.taskEvents?.mark({ taskId, kind: "stopped_by_owner", urgent: false });
    const chatId = (await this.deps.tasks.repo.get(taskId))?.sessionId;
    if (!chatId) return 0;
    const turns = this.attached?.chats.activeTurns(chatId) ?? [];
    // One turn that will not stop, as one that ended meanwhile, stops neither
    // the others nor the turn-down below.
    for (const turnId of turns) {
      await this.attached?.chats.interruptTurn(turnId).catch((error: unknown) =>
        log.warn("failed to stop a stopped task's turn", {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    // Nothing approved later runs for a stopped task: turned down once its
    // work has stopped, so one its turn asked for while stopping is too.
    await this.turnDownForStop(chatId, Date.now());
    return turns.length;
  }

  /**
   * Its owner's Stop in task `taskId`'s chat ended a turn. A scheduled task
   * ends only that run: what it asked for is turned down, and the task, its
   * schedule and its checks stay, since only the task list's Stop ends a
   * schedule. Any other task stops as any Stop stops it.
   */
  async stopFromChat(taskId: string): Promise<void> {
    if (await this.deps.schedules?.of(taskId)) {
      const chatId = (await this.deps.tasks.repo.get(taskId))?.sessionId;
      if (chatId) await this.turnDownForStop(chatId, Date.now(), 0, "run");
      return;
    }
    await this.stopTask(taskId, "guardian");
  }

  /**
   * Attaches how Rome turns down a chat's pending approvals, once the
   * approval handling is up. Until then an expiry turns none down.
   */
  attachApprovalExpiry(
    expire: ((chatId: string, turnDown: TurnDown) => Promise<number>) | null,
  ): void {
    this.approvalExpiry = expire;
    // A stop a crash or a failure cut off before its approvals were turned
    // down is finished now, so a stopped task never keeps one pending.
    if (expire) void this.sweepStoppedApprovals();
  }

  /**
   * An approval was asked for in task chat `chatId` while its task is
   * stopped: everything pending there was the stopped work's, so it is
   * turned down.
   */
  async turnDownWhileStopped(chatId: string): Promise<void> {
    await this.turnDownForStop(chatId, Number.POSITIVE_INFINITY);
  }

  /** Turns down every approval still pending in a stopped task's chat. */
  async sweepStoppedApprovals(): Promise<void> {
    const chats = await this.deps.tasks.repo.stoppedTaskChats().catch((error: unknown) => {
      log.warn("failed to read the stopped tasks' chats", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [] as { chatId: string; stoppedAt: number }[];
    });
    // Nothing runs for a stopped task at start: every approval pending in its
    // chat was its stopped work's, one asked for while it stopped included.
    for (const { chatId } of chats) {
      await this.turnDownForStop(chatId, Number.POSITIVE_INFINITY);
    }
    // A stopped run's task runs on: only what began by its stop is turned down.
    for (const run of await this.stoppedRuns()) {
      await this.turnDownForStop(run.chatId, run.stoppedAt, 0, "run");
    }
  }

  private async stoppedRuns(): Promise<StoppedRun[]> {
    try {
      return parseStoppedRuns(await this.deps.settingsRepo.get(STOPPED_RUNS_SETTING_KEY));
    } catch (error) {
      log.warn("failed to read the stopped runs", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Keeps or drops stopped run `run` for the start sweep. Written only while
   * its turn-down has failed, so a stop that turns down at once writes nothing.
   */
  private async keepStoppedRun(run: StoppedRun, keep: boolean): Promise<void> {
    const runs = await this.stoppedRuns();
    const same = (other: StoppedRun) =>
      other.chatId === run.chatId && other.stoppedAt === run.stoppedAt;
    const held = runs.some(same);
    if (held === keep) return;
    const next = keep ? [...runs, run] : runs.filter((other) => !same(other));
    await this.deps.settingsRepo
      .set(STOPPED_RUNS_SETTING_KEY, { runs: next })
      .catch((error: unknown) =>
        log.warn("failed to keep a stopped run", {
          chatId: run.chatId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  /**
   * Turns down task chat `chatId`'s approvals still pending (approval-expiry.ts).
   * A failure reaches the caller, so an expiry that turned none down is not
   * taken as handled and is tried again.
   */
  async expireApprovals(chatId: string, turnDown: TurnDown): Promise<number> {
    return (await this.approvalExpiry?.(chatId, turnDown)) ?? 0;
  }

  /**
   * A task ended by a stop: nothing approved later runs for it, and no turn
   * carries on. The stop goes ahead whatever happens here; a failed turn-down
   * is tried again, backing off, and the next start sweeps any left.
   */
  private async turnDownForStop(
    chatId: string,
    stoppedAt: number,
    failures = 0,
    scope: StopScope = "task",
  ): Promise<void> {
    // A retry after the task was taken up again turns down nothing: the
    // approvals its new work asks for are its own. A run's stop keeps its
    // task, so its retry goes on: the cutoff holds it to the stopped run's.
    if (failures > 0 && scope === "task") {
      const row = await this.deps.tasks.repo.findBySession(chatId);
      if (row && (!stopHolds(row) || (row.stoppedAt?.getTime() ?? 0) > stoppedAt)) return;
    }
    try {
      // Only approvals that began by the time its work stopped: they were the
      // stopped work's.
      await this.expireApprovals(chatId, {
        until: stoppedAt,
        reason: "The task was stopped",
        resolvedBy: RESOLVED_BY_STOP,
        continueTurn: false,
      });
      if (scope === "run") await this.keepStoppedRun({ chatId, stoppedAt }, false);
    } catch (error) {
      log.warn("failed to turn down a stopped task chat's approvals", {
        chatId,
        failures: failures + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      // A stopped task's own row brings it back to the start sweep; a run's needs keeping.
      if (scope === "run") await this.keepStoppedRun({ chatId, stoppedAt }, true);
      const wait = Math.min(STOP_RETRY_FIRST_MS * 2 ** failures, STOP_RETRY_MAX_MS);
      setTimeout(
        () => void this.turnDownForStop(chatId, stoppedAt, failures + 1, scope),
        wait,
      ).unref?.();
    }
  }

  /** Cancels every check scheduled for task `taskId`, and its schedule, as when it is stopped or archived. */
  async cancelChecks(taskId: string): Promise<void> {
    const row = await this.deps.tasks.repo.get(taskId);
    if (!row) return;
    await this.deps.checks?.cancelFor(taskId, ownerOf(row)).catch((error: unknown) =>
      log.warn("failed to cancel a task's checks", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    await this.deps.schedules?.remove(taskId).catch((error: unknown) =>
      log.warn("failed to remove a task's schedule", {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /** Task chats whose scheduled run in flight reports only when it matters. */
  private readonly quietRuns = new Set<string>();

  /**
   * A scheduled run of task `taskId` fired at `firedAt`: its brief goes
   * straight into the task's own task chat, as the Concierge's words, with no
   * Concierge turn. The run comes back as any task's turn does. A run its
   * owner skipped, or one of a task that has stopped or lost its chat, sends
   * nothing; a stopped task's schedule is removed.
   */
  async runScheduledTask(
    taskId: string,
    firedAt: number,
  ): Promise<"sent" | "skipped" | "stopped" | "no_chat"> {
    const schedules = this.deps.schedules;
    const row = await this.deps.tasks.repo.get(taskId);
    if (!row || row.stoppedAt || row.archivedAt) {
      await schedules?.remove(taskId);
      return "stopped";
    }
    if (await schedules?.takeSkip(taskId, firedAt)) return "skipped";
    const schedule = await schedules?.of(taskId);
    if (!schedule) return "stopped";
    if (!row.sessionId || !(await this.deps.webchatRepo.getSession(row.sessionId))) {
      log.warn("a scheduled task has no task chat to run in", { taskId });
      return "no_chat";
    }
    const chatId = row.sessionId;
    if (schedule.report === "when_it_matters") this.quietRuns.add(chatId);
    const sent = await this.dashboard.send(
      taskChatPlace(chatId),
      { text: schedule.brief, ...(schedule.skill ? { skillName: schedule.skill } : {}) },
      CONCIERGE_ACCOUNT,
    );
    if (!sent.ok) {
      this.quietRuns.delete(chatId);
      throw new Error("error" in sent ? sent.error : "The task chat cannot take the scheduled run");
    }
    return "sent";
  }

  /**
   * Whether the turn that just ended in task chat `chatId` was a scheduled
   * run that reports only when it matters. Read once per run.
   */
  takeQuietRun(chatId: string): boolean {
    return this.quietRuns.delete(chatId);
  }

  /**
   * The owner cancelled check `checkId` of chat `chatId` from the chat's
   * checks. One for a task tells the Concierge quietly, as cancelling from
   * the task's row does. Answers whether there was such a check.
   */
  async cancelCheckByOwner(chatId: string, checkId: string): Promise<boolean> {
    const checks = this.deps.checks;
    if (!checks) return false;
    const check = (await checks.inChat(chatId)).find((found) => found.id === checkId);
    if (!(await checks.cancel(chatId, checkId))) return false;
    if (check?.taskId) {
      this.taskEvents?.mark({
        taskId: check.taskId,
        kind: "checks_cancelled_by_owner",
        urgent: false,
      });
      await this.deps.tasks.taskChanged(check.taskId);
    }
    return true;
  }

  /**
   * Task `taskId`'s owner called its checks off from its row: a wake-up is
   * removed, and its schedule skips only its next run. A failure reaches the
   * caller; once they are cancelled, the Concierge hears of it
   * quietly, so it expects no wake-up from them.
   */
  async cancelChecksByOwner(taskId: string): Promise<void> {
    const row = await this.deps.tasks.repo.get(taskId);
    if (!row) return;
    await this.deps.checks?.cancelFor(taskId, ownerOf(row), { keepSchedule: true });
    this.taskEvents?.mark({ taskId, kind: "checks_cancelled_by_owner", urgent: false });
    await this.deps.tasks.taskChanged(taskId);
  }

  /**
   * New words reached task chat `chatId` from its owner, typed in the chat:
   * a task its owner or the Concierge stopped is taken up again. One stopped
   * by archiving or deleting its chat stays stopped.
   */
  async resumeTaskChat(chatId: string): Promise<void> {
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (!chat || isConciergeChat(chat)) return;
    const row = await this.deps.tasks.repo.findBySession(chatId);
    if (row && ownerOf(row) === ownerOf(chat)) await this.deps.tasks.repo.resume(row.id);
  }

  /**
   * Cancels the checks a stopped or archived task still has, as a crash
   * between its stop and its cancel may leave. Run once at startup.
   */
  async cancelChecksOfEndedTasks(): Promise<void> {
    for (const taskId of (await this.deps.checks?.pendingTaskIds()) ?? []) {
      const row = await this.deps.tasks.repo.get(taskId);
      if (row && (row.stoppedAt || row.archivedAt)) await this.cancelChecks(taskId);
    }
  }

  /** Unarchived task chat `chatId` brings back the row archiving it archived; the task stays stopped. */
  async restoreTaskChat(chatId: string): Promise<void> {
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (chat) await this.deps.tasks.repo.restoreWithChat(chatId, ownerOf(chat));
  }

  /** A task chat was deleted. Its row stays, unlinked; the Concierge hears of it quietly. */
  chatDeleted(taskId: string): void {
    this.taskEvents?.mark({ taskId, kind: "chat_deleted", urgent: false });
  }

  /** Where a turn that failed before it started is told, once {@link startConciergeEvents} runs. */
  attachFailedBeforeStart(handler: ((event: AgentTurnFailedBeforeStart) => void) | null): void {
    this.failedBeforeStart = handler;
  }

  /** A dashboard turn failed before any agent session opened, so nothing else tells of it. */
  turnFailedBeforeStart(event: AgentTurnFailedBeforeStart): void {
    this.failedBeforeStart?.(event);
  }
}
