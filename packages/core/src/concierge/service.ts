// Concierge: texting-style chats that hand work to task chats. One Concierge
// talks in a main chat and in any topic chats its owner starts, all sharing one
// memory, one list of follows and one task list (docs/domains/chats.md#concierge-chat,
// docs/adrs/one-concierge-with-several-chats.md). Design: rome-os/rome#1344.

import { CONCIERGE_CHAT_ID, type ConciergeChatRef } from "@rome/api-types/concierge";
import type { Account, AgentTurnFailure, BackendTurnParams } from "@rome-os/app-runtime";
import type { MessageRepository } from "../chats/message-repository.js";
import type { Place } from "../chats/place.js";
import { DASHBOARD_PLATFORM, type Body, type SendResult } from "../connections/send.js";
import { claudeUsesApiKey, type AIToolStateValue } from "../core/ai-tool-state.js";
import { webchatSessionKey } from "../core/agent-session-key.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import type { SkillCatalog } from "../core/skill-catalog.js";
import {
  resolveWebchatLargeModelSelection,
  WEBCHAT_LARGE_MODEL_SELECTIONS,
  type ModelSelectionId,
} from "../core/model-selector.js";
import type { AgentTurnFailedBeforeStart } from "../core/agent-lifecycle.js";
import type { AgentSessionManager } from "../core/agent-session.js";
import type { SessionRepository } from "../agent/index.js";
import {
  quotaSwitchTarget,
  sameProviderTarget,
  soleExhaustedProvider,
} from "../core/quota-switch.js";
import { v7 as uuidv7 } from "uuid";
import { createLogger } from "../logger.js";
import type { ConciergeFollowing } from "./following.js";
import type { TaskEventCoalescer } from "./task-events.js";
import type { ConciergeTasks } from "./tasks.js";
import {
  type ConciergeOwner,
  GUARDIAN_OWNER,
  mainChatIdOf,
  ownerOf,
  storedChatId,
} from "./owner.js";
import {
  CONCIERGE_AGENT_ID,
  canOpenChat,
  isConciergeAgent,
  isConciergeChat,
  isMainConciergeChat,
  privateOwnerOf,
  TASK_CHAT_TRIGGER_KIND,
} from "./privacy.js";
import { ALL_OWNERS_SERVED, type ConciergeOwners, type OwnerProfile } from "./owners.js";

import { ambiguousQuota, type FailoverReason } from "./failover-reason.js";

const log = createLogger("concierge");

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
/** The guardian setting that turns Concierge on. Any value but `true` is off. */
const EXPERIMENTAL_CONCIERGE_SETTING_KEY = "experimentalConcierge";
/** Concierge's own account on the dashboard, which says what it sends into a
 *  task chat. */
export const CONCIERGE_ACCOUNT: Account = { platform: DASHBOARD_PLATFORM, id: CONCIERGE_AGENT_ID };

/** The setting that keeps the owner of each visitor's deleted Concierge chat. */
const RETIRED_CHATS_SETTING_KEY = "conciergeRetiredChats";

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
  /** Ids of the chat's turns whose streams have not ended, running or queued. */
  activeTurns(chatId: string): string[];
  interruptTurn(turnId: string): Promise<void>;
}

/** The dashboard as Concierge reaches it. The API layer builds it after
 *  Concierge, so it is attached once that layer is up. */
export interface ConciergeDashboard {
  chats: TaskChats;
  /** The ordinary send into a chat (connections/send.ts), with the dashboard able to take it. */
  send(place: Place, body: Body, as: Account): Promise<SendResult>;
}

export interface ConciergeDeps {
  skillCatalog: Pick<SkillCatalog, "get">;
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
    | "setSessionTrigger"
    | "listProjects"
  >;
  /** The todo list. */
  tasks: ConciergeTasks;
  approvals: Pick<ApprovalsRepository, "onCreated">;
  messages: Pick<MessageRepository, "recent" | "before">;
  sessionRepository: Pick<SessionRepository, "current">;
  aiToolState: { get(): AIToolStateValue };
  agentSessionManager: Pick<AgentSessionManager, "peek">;
  /** Runs a system turn in a chat and waits for it to end. A quiet turn
   *  shows the guardian no sign that it runs, until the agent speaks. */
  /** Runs a backend turn; answers whether it ran to its end, when the runner says. */
  runBackendTurn: (
    params: BackendTurnParams,
    options?: { quiet?: boolean; inputLabel?: string },
  ) => Promise<"completed" | "failed" | void>;
}

export class ConciergeService {
  private readonly leftModels = new Map<string, number>();
  /** The main chat being created, per owner, so concurrent calls share one. */
  private readonly creating = new Map<ConciergeOwner, Promise<string>>();
  private attached: ConciergeDashboard | null = null;
  private taskEvents: TaskEventCoalescer | null = null;
  private failedBeforeStart: ((event: AgentTurnFailedBeforeStart) => void) | null = null;
  private attachedFollowing: ConciergeFollowing | null = null;

  constructor(readonly deps: ConciergeDeps) {}

  attachDashboard(dashboard: ConciergeDashboard): void {
    this.attached = dashboard;
  }

  /** The dashboard. Throws before the API layer has attached it, which no
   *  turn can outrun, since turns start from that layer. */
  get dashboard(): ConciergeDashboard {
    if (!this.attached) throw new Error("The dashboard is not up yet");
    return this.attached;
  }

  async isEnabled(): Promise<boolean> {
    try {
      return (await this.deps.settingsRepo.get(EXPERIMENTAL_CONCIERGE_SETTING_KEY)) === true;
    } catch (error) {
      log.warn("concierge setting unreadable, treating it as off", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
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
      "Concierge",
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
    const owner = await this.owners.profileOf(await this.ownerOfChat(chat.id));
    return `${conciergeChatLine(chat)}\n${conciergeOwnerLine(owner)}`;
  }

  /** Whether a chat is its owner's main Concierge chat. */
  isMainChat(chat: { id: string; ownerKey?: string | null }): boolean {
    return chat.id === mainChatIdOf(ownerOf(chat));
  }

  /**
   * Whose Concierge a chat is: the owner it records, or, for a visitor's
   * chat that was deleted, the owner kept for it then. The guardian otherwise.
   */
  async ownerOfChat(chatId: string | null | undefined): Promise<ConciergeOwner> {
    if (!chatId) return GUARDIAN_OWNER;
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (chat) return ownerOf(chat);
    const retired = (await this.deps.settingsRepo.get(RETIRED_CHATS_SETTING_KEY)) as Record<
      string,
      string
    > | null;
    return retired?.[chatId] ?? GUARDIAN_OWNER;
  }

  /** A Concierge chat that is not archived, as a list shows it, or null. */
  async conciergeChat(chatId: string): Promise<ConciergeChatRef | null> {
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (!chat || !isConciergeChat(chat) || chat.archivedAt) return null;
    return { id: chat.id, name: chat.name, main: this.isMainChat(chat) };
  }

  /**
   * Where something that reports to Concierge chat `chatId` goes: that chat
   * while it is a live Concierge chat, else its owner's main chat. Null names
   * the guardian's main chat. Answers null only while that main chat does not
   * exist.
   */
  async deliveryChat(chatId: string | null | undefined): Promise<string | null> {
    if (chatId && (await this.conciergeChat(chatId))) return chatId;
    return this.findChatId(await this.ownerOfChat(chatId));
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
   */
  async retireChat(chatId: string, how: RetiredHow): Promise<void> {
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (chatId === CONCIERGE_CHAT_ID || (chat && this.isMainChat(chat)))
      throw new Error("The main Concierge chat cannot be archived or deleted");
    if (!chat || !isConciergeChat(chat)) return;
    const owner = ownerOf(chat);
    // A deleted chat's row goes; its owner stays known, so what still names it
    // (a defer's wake-up) reaches that owner's main chat, never another's.
    if (how === "deleted" && owner !== GUARDIAN_OWNER) {
      const retired =
        ((await this.deps.settingsRepo.get(RETIRED_CHATS_SETTING_KEY)) as Record<
          string,
          string
        > | null) ?? {};
      await this.deps.settingsRepo.set(RETIRED_CHATS_SETTING_KEY, { ...retired, [chatId]: owner });
    }
    const main = await this.ensureChatId(owner);
    const follows = (await this.attachedFollowing?.moveToMainChat(chatId, storedChatId(main))) ?? 0;
    const tasks = await this.deps.tasks.repo.moveToMainChat(chatId, storedChatId(main));
    log.info("concierge chat retired", { chatId, how, follows, tasks });
    if (follows === 0 && tasks === 0) return;
    void this.runSystemTurn(
      main,
      `<concierge_chat_retired name="${attr(chat.name)}" how="${how}" follows="${follows}" tasks="${tasks}"/>`,
      { quiet: true, inputLabel: "Concierge chat retired" },
    ).catch((error: unknown) =>
      log.warn("retired chat notice failed", {
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
    const { claude, codex } = this.deps.aiToolState.get();
    if (claude.loggedIn === true && !claude.quotaExhausted && !claude.anthropicCompatible) {
      return "claude-sonnet";
    }
    if (codex.loggedIn === true && !codex.quotaExhausted) {
      return codex.lunaAccess ? "gpt-6-luna" : "gpt-5-6-terra";
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
    const state = this.deps.aiToolState.get();
    // An Auto chat whose first turn failed has no recorded provider yet.
    const from =
      selected?.providerId ??
      runtime?.provider ??
      failure?.provider ??
      soleExhaustedProvider(state);
    if (from !== "openai" && from !== "anthropic") return null;
    if (failure && failure.provider !== from) return null;
    const source = from === "openai" ? state.codex : state.claude;
    if (from === "anthropic" ? claudeUsesApiKey(source) : source.accountType === "api_key")
      return null;
    reason ??= source.quotaExhausted
      ? "quota"
      : // Rome credits pay for Codex while its login is out, so that alone is no failure.
        (from === "anthropic" && source.loggedIn === false) || source.needsReauth
        ? "login"
        : undefined;
    if (!reason) return null;
    const fromModel = selected?.model ?? runtime?.model ?? "";
    const same =
      !crossOnly &&
      (reason === "model_limit" || (reason === "quota" && ambiguousQuota(failure?.message ?? "")))
        ? sameProviderTarget(state, from, fromModel)
        : null;
    const cross = quotaSwitchTarget(state, from, true);
    const candidates = reason === "model_limit" ? [same, cross] : [cross, same];
    // A model each Concierge chat left, so one chat's move never blocks another's.
    const modelKey = (model: string) => `${chatId}\u0000${model.replace(/\[.*\]$/, "")}`;
    const target = candidates.find(
      (candidate) =>
        candidate &&
        (this.leftModels.get(
          modelKey(WEBCHAT_LARGE_MODEL_SELECTIONS[candidate.selectionId].model),
        ) ?? 0) <= Date.now(),
    );
    if (!target) return null;
    await this.deps.webchatRepo.updateSessionLargeModelSelection(chatId, target.selectionId);
    this.deps.agentSessionManager.peek(key)?.selectModel(target.selectionId);
    this.leftModels.set(modelKey(fromModel), Date.now() + 10 * 60_000);
    await this.deps.webchatRepo.addBackendMessage(chatId, uuidv7(), [
      {
        type: "quota_switch",
        from,
        to: target.provider,
        reason,
        fromModel,
        model: WEBCHAT_LARGE_MODEL_SELECTIONS[target.selectionId].model,
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
  async resolveTurn(params: BackendTurnParams): Promise<BackendTurnParams> {
    if (params.channel !== "webchat" || !isConciergeAgent(params.agentName)) return params;
    // Before the main chat exists, the turn stays where it was sent.
    const chatId = (await this.deliveryChat(params.threadId)) ?? params.threadId;
    const moved = chatId !== params.threadId;
    const sessionId =
      (!moved && params.sessionId) || (await this.runtimeOf(chatId)) || params.sessionId;
    const chat = await this.conciergeChat(chatId);
    const prompt =
      chat && !params.prompt.startsWith("<concierge_chat ")
        ? `${await this.turnHeader(chat)}\n\n${params.prompt}`
        : params.prompt;
    return { ...params, threadId: chatId, sessionId, prompt };
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
    options: { quiet?: boolean; inputLabel?: string } = {},
  ): Promise<boolean> {
    const params = await this.resolveTurn({
      agentName: CONCIERGE_AGENT_ID,
      sessionId: "",
      channel: "webchat",
      threadId: chatId,
      prompt,
    });
    if (!params.sessionId) return false;
    const outcome = await this.deps.runBackendTurn(params, options);
    return outcome === "completed";
  }

  /** The delivery of task-chat changes, once {@link startConciergeEvents} has started it. */
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

  /** The id of the todo row that links a chat, or null. Read before the chat is deleted. */
  async taskOfChat(chatId: string): Promise<string | null> {
    return (await this.deps.tasks.repo.findBySession(chatId))?.id ?? null;
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
