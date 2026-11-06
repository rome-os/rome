// The Session aggregate: one agent's conversation from one reset to the next.
// Vocabulary: docs/concepts/sessions.md. Repository port: ./session-repository.ts.

import { v7 as uuidv7 } from "uuid";

export type SessionId = string;
export type AgentName = string;
/** Opaque to Sessions. Minted by whatever opens a session and comes back to
 *  it, it names a run of sessions across resets. At most one session per
 *  continuity key and agent is active. docs/concepts/sessions.md#continuity-key */
export type ContinuityKey = string;
export type SessionStatus = "active" | "completed" | "error";

export interface CreateSessionOptions {
  continuityKey?: ContinuityKey;
  workingDir?: string;
  /** @deprecated A persisted fork's session must have the id the fork minted
   *  when its turn started, because the fork's chat and the turn's events
   *  already carry it. Every other caller leaves it out and Sessions mints
   *  the id. Goes when a fork's chat stops reusing the session id as its own. */
  deprecatedId?: SessionId;
  /** @deprecated The Rome chat (`rome_sessions.id`) the session records into,
   *  until the turn log keeps that link itself. */
  deprecatedChatId?: string;
}

export interface ReplaceSessionOptions {
  workingDir?: string;
  /** @deprecated The chat the successor records into. Omitted, the successor
   *  inherits the retired session's stored chat when the reset is written. */
  deprecatedChatId?: string;
}

/** What one turn ran on. */
export interface TurnRun {
  provider: string;
  providerThreadId?: string;
  model?: string;
  reasoningEffort?: string;
  /** Where the turn left the provider's thread, so a fork can branch at it.
   *  Recorded only with a `providerThreadId`. */
  checkpoint?: { turnId: string; checkpointId: string };
}

/** Where a completed turn left the provider's thread. Opaque to Sessions:
 *  each provider spells `checkpointId` its own way. */
export interface TurnCheckpoint {
  sessionId: SessionId;
  turnId: string;
  provider: string;
  providerThreadId: string;
  checkpointId: string;
}

/** A session's stored state, as the repository reads and writes it. */
export interface SessionState {
  id: SessionId;
  agentName: AgentName;
  continuityKey: ContinuityKey | null;
  status: SessionStatus;
  provider: string | null;
  providerThreadId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  workingDir: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  chatId: string | null;
}

/** The facts a session can change after it is created. The repository writes
 *  only the ones that changed, so two instances of one session, each changing
 *  a different fact, never undo each other's write. */
export type SessionChange =
  | "turn"
  | "reasoningEffort"
  | "workingDir"
  | "lastActiveAt"
  | "status"
  | "chat";

/**
 * One agent's conversation from one reset to the next: the agent, what it last
 * ran on and where, and whether it is still open. It holds nothing about
 * whoever uses it. Every change is in memory until the repository saves it.
 */
export class Session {
  private state: SessionState;
  private readonly changes = new Set<SessionChange>();
  /** Checkpoints recorded since the last save, one per turn. */
  private readonly checkpoints = new Map<string, TurnCheckpoint>();

  private constructor(state: SessionState) {
    this.state = state;
  }

  /** Birth. Sessions mints the id unless `deprecatedId` is given. The session
   *  starts active, on no provider. */
  static create(agentName: AgentName, options: CreateSessionOptions = {}): Session {
    const now = new Date();
    return new Session({
      id: options.deprecatedId ?? uuidv7(),
      agentName,
      continuityKey: options.continuityKey ?? null,
      status: "active",
      provider: null,
      providerThreadId: null,
      model: null,
      reasoningEffort: null,
      workingDir: options.workingDir ?? null,
      createdAt: now,
      lastActiveAt: now,
      chatId: options.deprecatedChatId ?? null,
    });
  }

  /** A session as the repository read it. Only the repository calls this. */
  static restore(state: SessionState): Session {
    return new Session({ ...state });
  }

  get id(): SessionId {
    return this.state.id;
  }
  get agentName(): AgentName {
    return this.state.agentName;
  }
  get continuityKey(): ContinuityKey | null {
    return this.state.continuityKey;
  }
  get status(): SessionStatus {
    return this.state.status;
  }
  get provider(): string | null {
    return this.state.provider;
  }
  /** The provider's thread for this session, which a resume continues. */
  get providerThreadId(): string | null {
    return this.state.providerThreadId;
  }
  /** The session model pin: the model that produced its history. */
  get model(): string | null {
    return this.state.model;
  }
  /** The effort the last turn ran with, in the provider's own terms. Display only. */
  get reasoningEffort(): string | null {
    return this.state.reasoningEffort;
  }
  get workingDir(): string | null {
    return this.state.workingDir;
  }
  get createdAt(): Date {
    return this.state.createdAt;
  }
  get lastActiveAt(): Date {
    return this.state.lastActiveAt;
  }

  /** @deprecated The chat the session records into. Goes with the turn log's move. */
  get deprecatedChatId(): string | null {
    return this.state.chatId;
  }

  /** @deprecated Whether the provider has a thread for this session, which the
   *  dashboard reads as "this side chat can continue". Sessions should answer
   *  that question itself. */
  get deprecatedHasProviderThread(): boolean {
    return this.state.providerThreadId !== null;
  }

  /**
   * What the last turn ran on, in one call. Provider, thread and model are
   * written together: a provider with no thread yet clears a stale thread and
   * model, so a resume never replays another provider's thread (the session
   * model pin rule). Effort and checkpoint are written only when given, and
   * a checkpoint only with a thread to branch from.
   */
  recordTurn(run: TurnRun): void {
    this.state.provider = run.provider;
    this.state.providerThreadId = run.providerThreadId ?? null;
    this.state.model = run.model ?? null;
    this.changes.add("turn");
    if (run.reasoningEffort !== undefined) {
      this.state.reasoningEffort = run.reasoningEffort;
      this.changes.add("reasoningEffort");
    }
    if (run.checkpoint && run.providerThreadId) {
      this.checkpoints.set(run.checkpoint.turnId, {
        sessionId: this.state.id,
        turnId: run.checkpoint.turnId,
        provider: run.provider,
        providerThreadId: run.providerThreadId,
        checkpointId: run.checkpoint.checkpointId,
      });
    }
  }

  /** The provider's transcript now lives here. */
  moveTo(workingDir: string): void {
    this.state.workingDir = workingDir;
    this.changes.add("workingDir");
  }

  /** The session was just active. The reset policy reads `lastActiveAt` to
   *  measure how long a session has been idle. */
  touch(): void {
    this.state.lastActiveAt = new Date();
    this.changes.add("lastActiveAt");
  }

  /** Ends the session. It stops being the current session of its continuity
   *  key, and can still be read but not resumed. */
  complete(): void {
    this.state.status = "completed";
    this.state.lastActiveAt = new Date();
    this.changes.add("status");
    this.changes.add("lastActiveAt");
  }

  /**
   * A reset: completes this session and returns its successor, with the same
   * agent and continuity key, on no provider. The successor is not stored
   * until the repository's `replace` writes both.
   */
  replace(options: ReplaceSessionOptions = {}): Session {
    this.complete();
    // The successor has no chat unless one is named: the repository gives it
    // the retired session's stored chat when it writes the reset.
    return Session.create(this.state.agentName, {
      continuityKey: this.state.continuityKey ?? undefined,
      workingDir: options.workingDir,
      deprecatedChatId: options.deprecatedChatId,
    });
  }

  /** @deprecated Records the chat only when none is recorded yet. Answers
   *  whether it did. */
  deprecatedRecordChat(chatId: string): boolean {
    if (this.state.chatId !== null) return false;
    this.state.chatId = chatId;
    this.changes.add("chat");
    return true;
  }

  /** @deprecated Only the repository calls this, on a successor that named
   *  no chat, with the chat the retired session's row held. */
  deprecatedInheritChat(chatId: string): void {
    this.state.chatId = chatId;
  }

  /** The state to write. Only the repository calls this. */
  snapshot(): SessionState {
    return { ...this.state };
  }

  /** The facts changed since the last save, and the checkpoints recorded
   *  since then, one per turn. Only the repository calls this, and
   *  `markSaved` once they are written. */
  pendingChanges(): { changes: ReadonlySet<SessionChange>; checkpoints: TurnCheckpoint[] } {
    return { changes: new Set(this.changes), checkpoints: [...this.checkpoints.values()] };
  }

  /** Only the repository calls this, after a save. */
  markSaved(): void {
    this.changes.clear();
    this.checkpoints.clear();
  }
}
