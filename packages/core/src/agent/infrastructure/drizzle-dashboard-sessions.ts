// The dashboard's sessions (`rome_sessions`), behind the DashboardSessions
// port in ../domain/session-parent.ts.

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../db/index.js";
import { romeSessions } from "../../db/schema.js";
import { parentTurnSession, type DashboardSessions } from "../domain/session-parent.js";
import type { SessionRecordId } from "../domain/subagent.js";

export class DrizzleDashboardSessions implements DashboardSessions {
  constructor(private readonly db: DrizzleDb) {}

  async parentSession(id: SessionRecordId): Promise<SessionRecordId | null | undefined> {
    const [row] = await this.db
      .select({ type: romeSessions.type, parentSessionId: romeSessions.parentSessionId })
      .from(romeSessions)
      .where(eq(romeSessions.id, id))
      .limit(1);
    if (!row) return undefined;
    return parentTurnSession(row.type, row.parentSessionId ?? null);
  }
}
