// The dashboard's sessions (`rome_sessions`), by the dashboard's id for each
// session. The agent context reads a session's parent turn and a subagent's
// session from them, and adds a fresh subagent's session to them.

import type { AgentName, SessionId } from "./session.js";
import type { SessionRecordId } from "./subagent.js";

/** A session as the dashboard holds it. */
export interface DashboardSession {
  type: string;
  name: string | null;
  /** Null for the core main agent. */
  agentName: AgentName | null;
  parentSessionId: SessionRecordId | null;
  projectName: string | null;
  projectPath: string | null;
}

/** A fresh subagent session, as the dashboard adds it. */
export interface NewSubagentSession {
  id: SessionId;
  name: string;
  agentName: AgentName | null;
  projectName: string | null;
  projectPath: string | null;
  parentSessionId: SessionRecordId;
  parentTurnId: string;
}

/** The dashboard's sessions, by the dashboard's id for each session. */
export interface DashboardSessions {
  /**
   * The parent turn's session of the session `id`, by the dashboard's id.
   * Null when the session is neither a subagent's nor a fork's, or names no
   * parent. Undefined when the dashboard has no session with the id.
   */
  parentSession(id: SessionRecordId): Promise<SessionRecordId | null | undefined>;

  /** The dashboard's session with this id, or null. */
  get(id: SessionRecordId): Promise<DashboardSession | null>;

  /**
   * Adds a fresh subagent session under its parent's. Does nothing if one with
   * the id exists. Fails when the parent's session is missing; anything past
   * the session itself is best effort and logged.
   */
  addSubagentSession(session: NewSubagentSession): Promise<void>;
}
