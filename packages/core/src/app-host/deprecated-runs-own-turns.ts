import type { Agent } from "../agent/index.js";

// Deprecated. Slated for removal (ZHA-231): Rome is not keeping a way for an app to run its agent's turns past the Inbox app, so the chief of staff will get its turns another way.

/**
 * The apps whose agents may run their own turns. Inbox then stands aside on
 * the accounts linked to such an agent, so no wake gate, Sentinel or Envoy
 * judges what they hear or send. The guardian linking an account does not
 * show that, so only first-party apps on this list get it.
 */
export const DEPRECATED_RUNS_OWN_TURNS_APPS: ReadonlySet<string> = new Set(["chief-of-staff"]);

/** Whether `agent`'s own app runs its turns, so the Inbox app answers no
 *  message on an account linked to it: an agent of an allowed app that sets
 *  `deprecatedRunsOwnTurns`. */
export function deprecatedRunsOwnTurns(agent: Agent | undefined): boolean {
  return (
    agent?.ownerType === "app" &&
    DEPRECATED_RUNS_OWN_TURNS_APPS.has(agent.ownerId) &&
    agent.definition.deprecatedRunsOwnTurns === true
  );
}
