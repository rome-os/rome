// The dashboard's sessions (`rome_sessions`), behind the DashboardSessions
// port in ../domain/dashboard-sessions.ts.

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import { romeSessions } from "../../db/schema.js";
import { createLogger } from "../../logger.js";
import type {
  DashboardSession,
  DashboardSessions,
  NewSubagentSession,
} from "../domain/dashboard-sessions.js";
import { parentTurnSession } from "../domain/session-parent.js";
import type { SessionRecordId } from "../domain/subagent.js";

const log = createLogger("dashboard-sessions");

export class DrizzleDashboardSessions implements DashboardSessions {
  constructor(
    private readonly db: DrizzleDb,
    private readonly webchat: Pick<
      WebChatRepository,
      "getSession" | "ensureRomeSession" | "recordSessionInChat"
    >,
  ) {}

  async parentSession(id: SessionRecordId): Promise<SessionRecordId | null | undefined> {
    const [row] = await this.db
      .select({ type: romeSessions.type, parentSessionId: romeSessions.parentSessionId })
      .from(romeSessions)
      .where(eq(romeSessions.id, id))
      .limit(1);
    if (!row) return undefined;
    return parentTurnSession(row.type, row.parentSessionId ?? null);
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
