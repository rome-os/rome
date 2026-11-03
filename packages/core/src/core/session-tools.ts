import type { FacadeToolDef } from "./mcp-facade.js";
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
}

/**
 * Supplies the extra tools one session carries. Asked each time the session
 * opens its provider, so an answer that depends on settings follows them on
 * the next open. An empty answer registers nothing.
 */
export type SessionToolsProvider = (context: SessionToolContext) => Promise<FacadeToolDef[]>;

/** Tools that need no running turn, so the Concierge's task review can use
 *  them from a fork (concierge/reviewer.ts). */
const FORK_SAFE_TOOLS = new Set(["task_upsert", "task_list", "chat_read"]);

/**
 * The same tools with handlers that refuse, except the fork-safe ones. A
 * forked turn advertises its source's catalog unchanged, but its calls must
 * not act on the source's turn.
 */
export function detachSessionTools(tools: FacadeToolDef[]): FacadeToolDef[] {
  return tools.map((tool) =>
    FORK_SAFE_TOOLS.has(tool.name)
      ? tool
      : {
          ...tool,
          handler: async () => ({
            content: [{ type: "text", text: `${tool.name} is unavailable in a forked turn.` }],
            isError: true,
          }),
        },
  );
}
