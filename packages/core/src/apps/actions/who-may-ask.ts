// Who may ask for one of core's agent tools (agent-tool.ts), by what the tool
// does. On the dashboard only the guardian reads and changes what these tools
// reach, so an agent does only what the guardian asked for. Every agent tool
// passes this one check before it runs, and no tool holds a check of its own.

import type { ActionConfig } from "@rome-os/app-runtime";
import type { ActionExecutionStore } from "./context.js";

/** The turn a tool runs for: who it acts for, who can read it, and where. */
export type ToolTurn = Pick<ActionExecutionStore, "actor" | "audience" | "channelContext">;

/** Whose chat it is ("guardian" or "visitor:<account>"), or null for a chat
 * that no longer exists. */
export type OwnerOfChat = (chatId: string) => Promise<string | null>;

/** Why the turn may not call the tool, as the error the agent reads, or null
 * when it may. */
export type WhoMayAsk = (
  tool: { name: string; sideEffects: ActionConfig["sideEffects"] },
  turn: ToolTurn,
) => Promise<string | null>;

/** The check every agent tool passes: a read needs a turn that works for the
 * guardian, a write the guardian's own message in their private chat. */
export function whoMayAsk(ownerOfChat: OwnerOfChat): WhoMayAsk {
  return async (tool, turn) => {
    if (tool.sideEffects === "read-only") {
      return (await turnWorksForGuardian(ownerOfChat, turn))
        ? null
        : `guardian_only: Only the guardian's agents can call ${tool.name}, and this turn does not work for the guardian. Say so, and that the guardian can ask in their own chat.`;
    }
    switch (changeRefusalReason(turn)) {
      case "not_private":
        return `private_only: This chat is not private with the guardian, so ${tool.name} cannot run from it. Say so, and that they can ask in their own chat.`;
      case "not_guardian":
        return `needs_guardian: Only the guardian's own message can ask for ${tool.name}, and this turn did not start from one. Do nothing; tell them what you would do, so they can ask for it themselves.`;
      case null:
        return null;
    }
  };
}

/** Whether the turn works for the guardian, who alone reads these on the
 * dashboard. A visitor's turn, or a turn no one started in a visitor's chat, is
 * refused. A turn with neither an actor nor a chat cannot show it is the
 * guardian's and is refused too. A chat on a connection has no owner and is
 * the guardian's agent's. The same rule as `core:read_person`. */
async function turnWorksForGuardian(ownerOfChat: OwnerOfChat, turn: ToolTurn): Promise<boolean> {
  if (turn.actor && turn.actor.kind !== "guardian") return false;
  const thread = turn.channelContext;
  if (!turn.actor && !thread) return false;
  if (thread?.channel === "webchat") {
    const owner = thread.threadId ? await ownerOfChat(thread.threadId) : null;
    if (owner !== "guardian") return false;
  }
  return true;
}

/** Why the turn may not change what the guardian alone changes on the
 * dashboard, or null when it may. A change is the guardian's to ask for, in
 * their own private chat: never a routine, a followed event or another agent
 * acting on what it read. `not_private` is a chat someone else can read;
 * `not_guardian` is a turn the guardian's own signed-in message did not start.
 * The same rule as a write through `core:device_run`. */
function changeRefusalReason(turn: ToolTurn): "not_private" | "not_guardian" | null {
  if (turn.audience !== "private") return "not_private";
  const actor = turn.actor;
  if (actor?.kind !== "guardian" || actor.via !== "cookie") return "not_guardian";
  return null;
}
