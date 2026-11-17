import type { Agent } from "../agent/index.js";

/**
 * A test-only back door. The apps whose agents may keep the Inbox app off the
 * accounts linked to them, so the app runs the agent's turns itself. Only the
 * chief of staff, while it is tested on staging; no other app gets it.
 */
export const INBOX_BYPASS_APPS: ReadonlySet<string> = new Set(["chief-of-staff"]);

/** Whether the Inbox app must answer no message on an account linked to
 *  `agent`: an agent of an allowed app that sets `unsafeTestOnlyBypassInbox`. */
export function bypassesInbox(agent: Agent | undefined): boolean {
  return (
    agent?.ownerType === "app" &&
    INBOX_BYPASS_APPS.has(agent.ownerId) &&
    agent.definition.unsafeTestOnlyBypassInbox === true
  );
}
