// The dashboard's sessions (`rome_sessions`), read and written through the
// web chat repository, behind the DashboardSessions port in
// ../agent/domain/dashboard-sessions.ts.

import type { WebChatRepository } from "../db/repositories/webchat.js";
import { createLogger } from "../logger.js";
import type { DashboardSession, DashboardSessions, NewSubagentSession } from "../agent/index.js";
import { parentTurnSession } from "../agent/index.js";
import type { SessionRecordId } from "../agent/index.js";

const log = createLogger("dashboard-sessions");

export class WebChatDashboardSessions implements DashboardSessions {
  constructor(
    private readonly webchat: Pick<
      WebChatRepository,
      "getSession" | "ensureRomeSession" | "recordSessionInChat"
    >,
  ) {}

  async parentSession(id: SessionRecordId): Promise<SessionRecordId | null | undefined> {
    const session = await this.get(id);
    if (!session) return undefined;
    return parentTurnSession(session.type, session.parentSessionId);
  }

  async get(id: SessionRecordId): Promise<DashboardSession | null> {
    const row = await this.webchat.getSession(id);
    if (!row) return null;
    return {
      type: row.type,
      name: row.name ?? null,
      agentName: row.agentName ?? null,
      parentSessionId: row.parentSessionId ?? null,
      projectName: row.projectName ?? null,
      projectPath: row.projectPath ?? null,
    };
  }

  async addSubagentSession(session: NewSubagentSession): Promise<void> {
    await this.webchat.ensureRomeSession({
      id: session.id,
      type: "subagent",
      name: session.name,
      agentName: session.agentName,
      projectName: session.projectName ?? undefined,
      projectPath: session.projectPath ?? undefined,
      parentSessionId: session.parentSessionId,
      parentTurnId: session.parentTurnId,
    });
    // A subagent's chat is minted under its own session id.
    try {
      await this.webchat.recordSessionInChat(session.id, session.id);
    } catch (err) {
      log.warn("failed to record the chat that has the subagent's session", {
        agentName: session.agentName ?? "main",
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
