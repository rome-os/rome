import type { SessionsRepository } from "../db/repositories/sessions.js";
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
        workingDir?: string | null;
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
      workingDir: row.workingDir,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
    };
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
        workingDir?: string | null;
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
      workingDir: row.workingDir,
    };
  }

  async createSession(session: AgentSession): Promise<void> {
    await this.sessionsRepository.create({
      id: session.id,
      agentName: session.agentName,
      channelThreadKey: session.channelThreadKey,
      status: session.status,
      workingDir: session.workingDir,
    });
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
