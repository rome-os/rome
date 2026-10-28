// Concierge: one fixed texting-style conversation that hands work to task
// chats. Design: rome-os/rome#1344.

import type { BackendTurnParams } from "@rome-os/app-runtime";
import type { AIToolStateValue } from "../core/ai-tool-state.js";
import { webchatSessionKey } from "../core/agent-session-key.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { SessionManager } from "../core/session-manager.js";
import type { ModelSelectionId } from "../core/model-selector.js";
import { createLogger } from "../logger.js";
import type { ChatApi } from "./chat-api.js";

const log = createLogger("concierge");

/** The canonical id of the core agent behind the Concierge conversation. */
export const CONCIERGE_AGENT_ID = "core:concierge";
/** The Concierge chat's fixed id, so the dashboard opens it at `/chat/concierge`. */
export const CONCIERGE_CHAT_ID = "concierge";
/** The guardian setting that turns Concierge on. Any value but `true` is off. */
const EXPERIMENTAL_CONCIERGE_SETTING_KEY = "experimentalConcierge";
/** `rome_sessions.trigger_kind` of a task chat Concierge started. */
export const TASK_CHAT_TRIGGER_KIND = "concierge";

export function isConciergeAgent(agentName: string | null | undefined): boolean {
  return agentName === CONCIERGE_AGENT_ID || agentName === "concierge";
}

export interface ConciergeDeps {
  settingsRepo: Pick<SettingsRepository, "get">;
  webchatRepo: Pick<
    WebChatRepository,
    | "createSession"
    | "getSession"
    | "getMessages"
    | "getTurnChatMessages"
    | "addBackendMessage"
    | "setSessionTrigger"
    | "listProjects"
  >;
  sessionManager: Pick<SessionManager, "findReusableSession">;
  aiToolState: { get(): AIToolStateValue };
  chatApi: ChatApi;
  /** Runs a system turn in a chat and waits for it to end. */
  runBackendTurn: (params: BackendTurnParams) => Promise<void>;
}

/**
 * Holds the in-process state Concierge needs between a turn and its
 * lifecycle event: which task-chat inputs it posted.
 * The state is advisory and lost on restart.
 */
export class ConciergeService {
  private readonly postedInputs = new Set<string>();
  private creating: Promise<string> | null = null;

  constructor(readonly deps: ConciergeDeps) {}

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

  /** Records an input Concierge posts to a task chat. Its id is the user message's id. */
  markPosted(inputId: string): void {
    this.postedInputs.add(inputId);
  }

  /**
   * Whether any of a finished task-chat turn's user messages is an input
   * Concierge posted. Forgets those inputs. A follow-up the task chat queued
   * or deferred sits under the turn that answered it, not the receipt's turn.
   */
  takePosted(messageIds: string[]): boolean {
    let posted = false;
    for (const id of messageIds) if (this.postedInputs.delete(id)) posted = true;
    return posted;
  }
}
