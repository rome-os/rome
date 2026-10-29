// Concierge: one fixed texting-style conversation that hands work to task
// chats. Design: rome-os/rome#1344.

import type { Account, BackendTurnParams } from "@rome-os/app-runtime";
import type { MessageRepository } from "../chats/message-repository.js";
import type { Place } from "../chats/place.js";
import { DASHBOARD_PLATFORM, type Body, type SendResult } from "../chats/send.js";
import type { AIToolStateValue } from "../core/ai-tool-state.js";
import { webchatSessionKey } from "../core/agent-session-key.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { SessionManager } from "../core/session-manager.js";
import type { ModelSelectionId } from "../core/model-selector.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge");

/** The canonical id of the core agent behind the Concierge conversation. */
export const CONCIERGE_AGENT_ID = "core:concierge";
/** The Concierge chat's fixed id, so the dashboard opens it at `/chat/concierge`. */
export const CONCIERGE_CHAT_ID = "concierge";
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
  /** Chats' ordinary send (chats/send.ts), with the dashboard able to take it. */
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
    | "getTurnChatMessages"
    | "addBackendMessage"
    | "setSessionTrigger"
    | "listProjects"
  >;
  messages: Pick<MessageRepository, "recent" | "before">;
  sessionManager: Pick<SessionManager, "findReusableSession">;
  aiToolState: { get(): AIToolStateValue };
  /** Runs a system turn in a chat and waits for it to end. */
  runBackendTurn: (params: BackendTurnParams) => Promise<void>;
}

export class ConciergeService {
  private creating: Promise<string> | null = null;
  private attached: ConciergeDashboard | null = null;

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
   * share one creation. Its model is picked once, here; the guardian changes
   * it later with the chat's model picker.
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

  /** The runtime session id of the Concierge chat, or null before its first turn. */
  async runtimeSessionId(chatId: string): Promise<string | null> {
    const row = await this.deps.sessionManager.findReusableSession(
      webchatSessionKey(chatId),
      CONCIERGE_AGENT_ID,
    );
    return row?.id ?? null;
  }

  /** Runs `prompt` as a system turn in the Concierge chat. A no-op before its first turn. */
  async runSystemTurn(chatId: string, prompt: string): Promise<void> {
    const sessionId = await this.runtimeSessionId(chatId);
    if (!sessionId) return;
    await this.deps.runBackendTurn({
      agentName: CONCIERGE_AGENT_ID,
      sessionId,
      channel: "webchat",
      threadId: chatId,
      prompt,
    });
  }
}
