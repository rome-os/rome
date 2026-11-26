// Who may ask for one of core's agent tools (agent-tool.ts), by what the tool
// does. Any turn reads. Every agent tool passes this one check before it runs,
// and no tool holds a check of its own.

import type { ActionConfig } from "@rome-os/app-runtime";
import type { ActionExecutionStore } from "./context.js";

/** The turn a tool runs for: who it acts for, who can read it, and where. */
export type ToolTurn = Pick<ActionExecutionStore, "actor" | "audience" | "channelContext">;

/** Why the turn may not call the tool, as the error the agent reads, or null
 * when it may. */
export type WhoMayAsk = (
  tool: { name: string; sideEffects: ActionConfig["sideEffects"] },
  turn: ToolTurn,
) => Promise<string | null>;

/** The check every agent tool passes: a read asks nothing of its turn, a write
 * needs the guardian's own message in their private chat. */
export const whoMayAsk: WhoMayAsk = async (tool, turn) => {
  if (tool.sideEffects === "read-only") return null;
  switch (changeRefusalReason(turn)) {
    case "not_private":
      return `private_only: This chat is not private with the guardian, so ${tool.name} cannot run from it. Say so, and that they can ask in their own chat.`;
    case "not_guardian":
      return `needs_guardian: Only the guardian's own message can ask for ${tool.name}, and this turn did not start from one. Do nothing; tell them what you would do, so they can ask for it themselves.`;
    case null:
      return null;
  }
};

/** Why the turn may not change what the guardian alone changes on the
 * dashboard, or null when it may. A change is the guardian's to ask for, in
 * their own private chat: never a routine, a followed event or another agent
 * acting on what it read. `not_private` is a chat someone else can read;
 * `not_guardian` is a turn the guardian's own signed-in message did not start. */
export function changeRefusalReason(turn: ToolTurn): "not_private" | "not_guardian" | null {
  if (turn.audience !== "private") return "not_private";
  const actor = turn.actor;
  if (actor?.kind !== "guardian" || actor.via !== "cookie") return "not_guardian";
  return null;
}
