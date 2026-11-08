import type { RomeTool } from "../agent/index.js";
import type { NotifyLevel } from "../lib/notify-client.js";
import type { ThreadContext } from "./types.js";

/** What a session-tools provider sees of the session it equips. */
export interface SessionToolContext {
  /** Canonical agent id, e.g. `core:main`. */
  agentName: string;
  channelThreadKey: string;
  /** Runtime session id. */
  sessionId: string;
  isSubagent: boolean;
  /** The running turn's id, or undefined between turns. */
  getTurnId(): string | undefined;
  /** The running turn's thread, else the session's. */
  getThreadContext(): ThreadContext | undefined;
  /** The level the running turn pushes its first said message at, or
   *  undefined when it pushes nothing. */
  getTurnPushLevel(): NotifyLevel | undefined;
}

/**
 * Supplies the extra tools one session carries. Asked each time the session
 * opens its provider, so an answer that depends on settings follows them on
 * the next open. An empty answer registers nothing.
 */
export type SessionToolsProvider = (context: SessionToolContext) => Promise<RomeTool[]>;
