// Concierge: one fixed texting-style conversation that hands work to task
// chats. Design: rome-os/rome#1344.

import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import type { Account, BackendTurnParams } from "@rome-os/app-runtime";
import type { MessageRepository } from "../chats/message-repository.js";
import type { Place } from "../chats/place.js";
import { DASHBOARD_PLATFORM, type Body, type SendResult } from "../connections/send.js";
import type { AIToolStateValue } from "../core/ai-tool-state.js";
import type { SessionCaller } from "../core/session-caller.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { ApprovalsRepository } from "../db/repositories/approvals.js";
import {
  resolveWebchatLargeModelSelection,
  WEBCHAT_LARGE_MODEL_SELECTIONS,
  type ModelSelectionId,
} from "../core/model-selector.js";
import type { AgentSessionManager } from "../core/agent-session.js";
import { quotaSwitchTarget, soleExhaustedProvider } from "../core/quota-switch.js";
import { v7 as uuidv7 } from "uuid";
import { createLogger } from "../logger.js";
import type { ConciergeFollowing } from "./following.js";
import type { TaskEventCoalescer } from "./task-events.js";
import type { ConciergeTasks } from "./tasks.js";

const log = createLogger("concierge");

/** The canonical id of the core agent behind the Concierge conversation. */
export const CONCIERGE_AGENT_ID = "core:concierge";
export { CONCIERGE_CHAT_ID };
/** The guardian setting that turns Concierge on. Any value but `true` is off. */
const EXPERIMENTAL_CONCIERGE_SETTING_KEY = "experimentalConcierge";
/** `rome_sessions.trigger_kind` of a task chat Concierge started. */
export const TASK_CHAT_TRIGGER_KIND = "concierge";
/** Concierge's own account on the dashboard, which says what it sends into a
 *  task chat. */
export const CONCIERGE_ACCOUNT: Account = { platform: DASHBOARD_PLATFORM, id: CONCIERGE_AGENT_ID };

export function isConciergeAgent(agentName: string | null | undefined): boolean {
  return agentName === CONCIERGE_AGENT_ID || agentName === "concierge";
}

/**
 * The dashboard's chat operations a task chat needs beyond saying something
 * in it: starting the chat, and its turns' state. They belong to the
 * dashboard and to Agents, not to Chats.
 */
export interface TaskChats {
  /** Start a chat for the guardian and answer its id. */
  startChat(input: { agentName?: string; projectPath?: string }): Promise<string>;
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
  settingsRepo: Pick<SettingsRepository, "get">;
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
  aiToolState: { get(): AIToolStateValue };
  agentSessionManager: Pick<AgentSessionManager, "live" | "find">;
  /** Runs a system turn in a chat and waits for it to end. A quiet turn
   *  shows the guardian no sign that it runs, until the agent speaks. */
  /** Runs a backend turn; answers whether it ran to its end, when the runner says. */
  runBackendTurn: (
    params: BackendTurnParams,
    options?: { quiet?: boolean; inputLabel?: string },
  ) => Promise<"completed" | "failed" | void>;
}

export class ConciergeService {
  private creating: Promise<string> | null = null;
  private attached: ConciergeDashboard | null = null;
  private taskEvents: TaskEventCoalescer | null = null;
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

  /** The Concierge chat's id, or null when it does not exist yet. */
  async findChatId(): Promise<string | null> {
    return (await this.deps.webchatRepo.getSession(CONCIERGE_CHAT_ID)) ? CONCIERGE_CHAT_ID : null;
  }

  /**
   * The Concierge chat's id. Creates the chat on first use; concurrent calls
   * share one creation. The initial model is picked here; later selections
   * and quota failover are stored on the chat.
   */
  async ensureChatId(): Promise<string> {
    if (await this.findChatId()) return CONCIERGE_CHAT_ID;
    this.creating ??= this.createChat().finally(() => {
      this.creating = null;
    });
    return await this.creating;
  }

  private async createChat(): Promise<string> {
    await this.deps.webchatRepo.createSession(
      CONCIERGE_CHAT_ID,
      "Concierge",
      undefined,
      undefined,
      this.pickModel(),
      undefined,
      CONCIERGE_AGENT_ID,
    );
    log.info("concierge chat created", { chatId: CONCIERGE_CHAT_ID });
    return CONCIERGE_CHAT_ID;
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

  /**
   * Moves the Concierge chat to the other subscription when its provider is
   * flagged out of quota and the other is eligible, and records the notice.
   * Null for any other chat, or when nothing moved.
   */
  async switchIfExhausted(chatId: string) {
    if (chatId !== CONCIERGE_CHAT_ID) return null;
    const chat = await this.deps.webchatRepo.getSession(chatId);
    if (!chat) return null;
    const caller: SessionCaller = { kind: "chat", chatId };
    const selected = resolveWebchatLargeModelSelection(chat.largeModelSelection)?.providerId;
    const pinned =
      selected ?? (await this.deps.agentSessionManager.find(CONCIERGE_AGENT_ID, caller))?.provider;
    const state = this.deps.aiToolState.get();
    const from = pinned ?? soleExhaustedProvider(state);
    if (from !== "openai" && from !== "anthropic") return null;
    const target = quotaSwitchTarget(state, from);
    if (!target) return null;
    await this.deps.webchatRepo.updateSessionLargeModelSelection(chatId, target.selectionId);
    this.deps.agentSessionManager.live(CONCIERGE_AGENT_ID, caller)?.selectModel(target.selectionId);
    await this.deps.webchatRepo.addBackendMessage(chatId, uuidv7(), [
      {
        type: "quota_switch",
        from,
        to: target.provider,
        model: WEBCHAT_LARGE_MODEL_SELECTIONS[target.selectionId].model,
      },
    ]);
    return { from, to: target.provider, selectionId: target.selectionId };
  }

  /** The runtime session id of the Concierge chat, or null before its first turn. */
  async runtimeSessionId(chatId: string): Promise<string | null> {
    const stored = await this.deps.agentSessionManager.find(CONCIERGE_AGENT_ID, {
      kind: "chat",
      chatId,
    });
    return stored?.sessionId ?? null;
  }

  /**
   * Runs `prompt` as a system turn in the Concierge chat. Answers whether a
   * turn ran to its end: false before the chat's first turn, and when the turn
   * errored or was stopped.
   */
  async runSystemTurn(
    chatId: string,
    prompt: string,
    options: { quiet?: boolean; inputLabel?: string } = {},
  ): Promise<boolean> {
    const sessionId = await this.runtimeSessionId(chatId);
    if (!sessionId) return false;
    const outcome = await this.deps.runBackendTurn(
      {
        agentName: CONCIERGE_AGENT_ID,
        sessionId,
        channel: "webchat",
        threadId: chatId,
        prompt,
      },
      options,
    );
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
}
