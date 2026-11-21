// The recorded sessions (`rome_sessions`), by each session's record id, for
// chats on every platform. The agent context reads a session's parent turn and
// a subagent's session from them, and adds a fresh subagent's session to them.

import type { AgentName, SessionId } from "./session.js";
import type { SessionRecordId } from "./subagent.js";

/** A session as its record holds it. */
export interface RecordedSession {
  type: string;
  name: string | null;
  /** Null for the core main agent. */
  agentName: AgentName | null;
  parentSessionId: SessionRecordId | null;
  projectName: string | null;
  projectPath: string | null;
}

/** A fresh subagent session, as its record is added. */
export interface NewSubagentSession {
  id: SessionId;
  name: string;
  agentName: AgentName | null;
  projectName: string | null;
  projectPath: string | null;
  parentSessionId: SessionRecordId;
  parentTurnId: string;
}

/** The recorded sessions, by each session's record id. */
export interface RecordedSessions {
  /**
   * The parent turn's session of the session `id`, by its record id.
   * Null when the session is neither a subagent's nor a fork's, or names no
   * parent. Undefined when no session is recorded with the id.
   */
  parentSession(id: SessionRecordId): Promise<SessionRecordId | null | undefined>;

  /** The session recorded with this id, or null. */
  get(id: SessionRecordId): Promise<RecordedSession | null>;

  /**
   * Adds a fresh subagent session under its parent's. Does nothing if one with
   * the id exists. Fails when the parent's session is missing; anything past
   * the session itself is best effort and logged.
   */
  addSubagentSession(session: NewSubagentSession): Promise<void>;
}
