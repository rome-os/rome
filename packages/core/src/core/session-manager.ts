import type {
  SessionsRepository,
  StoredSessionTurnCheckpoint,
} from "../db/repositories/sessions.js";
import type { AgentSession } from "../types.js";
import { resolveArtifactId, type ArtifactIdentityContext } from "../apps/artifact-id.js";

export class SessionManager {
  constructor(
    private sessionsRepository: SessionsRepository,
    private readonly identity?: ArtifactIdentityContext,
  ) {}

  /**
   * Find the active provider/runtime session for a stable agent + channel
   * thread key. Policy evaluation happens in the serialized acquire path.
   */
  async findReusableSession(
    channelThreadKey: string,
    agentName?: string,
  ): Promise<
    | {
        id: string;
        provider: string | null;
        providerThreadId: string | null;
        model: string | null;
        reasoningEffort: string | null;
        createdAt: Date;
        lastActiveAt: Date;
      }
    | undefined
  > {
    const row =
      this.identity && agentName
        ? (await this.sessionsRepository.findActiveByChannelThreadKey(channelThreadKey)).find(
            (candidate) => this.sameAgent(candidate.agentName, agentName),
          )
        : await this.sessionsRepository.findByChannelThreadKey(channelThreadKey, agentName);
    if (!row) return undefined;
    return {
      id: row.id,
      provider: row.provider,
      providerThreadId: row.providerThreadId,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
    };
  }

  async rotateProviderGeneration(input: {
    agentName: string;
    channelThreadKey: string;
    newSessionId: string;
  }) {
    return await this.sessionsRepository.rotateProviderGeneration(input);
  }

  /**
   * Resolve an explicit session id to its stored session key. This is for callers
   * that already hold a returned session id (for example, `summon` follow-ups);
   * unlike implicit lookup, it resolves the exact runtime session handle.
   */
  async findResumableSessionById(
    sessionId: string,
    agentName?: string,
  ): Promise<
    | {
        id: string;
        channelThreadKey: string;
        provider: string | null;
        providerThreadId: string | null;
        model: string | null;
      }
    | undefined
  > {
    const row = await this.sessionsRepository.findById(sessionId);
    if (row && agentName && !this.sameAgent(row.agentName, agentName)) return undefined;
    if (!row || row.status !== "active" || !row.channelThreadKey) return undefined;
    return {
      id: row.id,
      channelThreadKey: row.channelThreadKey,
      provider: row.provider,
      providerThreadId: row.providerThreadId,
      model: row.model,
    };
  }

  async createSession(session: AgentSession): Promise<void> {
    await this.sessionsRepository.create({
      id: session.id,
      agentName: session.agentName,
      channelThreadKey: session.channelThreadKey,
      status: session.status,
    });
  }

  /** Update lastActiveAt timestamp. */
  async touchSession(sessionId: string): Promise<void> {
    await this.sessionsRepository.touch(sessionId);
  }

  async completeSession(sessionId: string): Promise<void> {
    await this.sessionsRepository.complete(sessionId);
  }

  /** Persist the provider-specific thread id (e.g. codex thread id) for future resume. */
  async setProviderThreadId(sessionId: string, providerThreadId: string): Promise<void> {
    await this.sessionsRepository.setProviderThreadId(sessionId, providerThreadId);
  }

  /** Persist which provider owns this conversation (+ its thread id and the
   *  concrete model that ran — the session model pin) so a resumed
   *  session routes back to the same model (Codex→Claude fallback continuity). */
  async setProviderInfo(
    sessionId: string,
    provider: string,
    providerThreadId?: string,
    model?: string,
  ): Promise<void> {
    await this.sessionsRepository.setProviderInfo(sessionId, provider, providerThreadId, model);
  }

  /** Persist the provider-reported effort the session's last successful model turn ran with. */
  async setReasoningEffort(sessionId: string, reasoningEffort: string): Promise<void> {
    await this.sessionsRepository.setReasoningEffort(sessionId, reasoningEffort);
  }

  /** Persist the provider-native history anchor for a completed Rome turn. */
  async setTurnCheckpoint(input: StoredSessionTurnCheckpoint): Promise<void> {
    await this.sessionsRepository.setTurnCheckpoint(input);
  }

  /** Resolve the exact provider history anchor for a Rome turn. */
  async getTurnCheckpoint(
    sessionId: string,
    turnId: string,
  ): Promise<StoredSessionTurnCheckpoint | null> {
    return await this.sessionsRepository.getTurnCheckpoint(sessionId, turnId);
  }

  private sameAgent(storedName: string, requestedName: string): boolean {
    if (!this.identity) return storedName === requestedName;
    try {
      return (
        resolveArtifactId({
          kind: "agent",
          value: storedName,
          legacyBindings: this.identity.legacyBindings,
        }) ===
        resolveArtifactId({
          kind: "agent",
          value: requestedName,
          legacyBindings: this.identity.legacyBindings,
        })
      );
    } catch {
      return false;
    }
  }
}

export function getChannelFromThreadKey(channelThreadKey: string): string {
  return channelThreadKey.split(":", 1)[0] ?? "";
}
