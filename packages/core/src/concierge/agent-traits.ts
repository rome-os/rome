import { CONCIERGE_AGENT_ID } from "../webchat/privacy.js";

/**
 * The traits Rome gives agents beyond what their files declare, for the agent
 * catalog. The Concierge's provider failover must reach a resumed chat's
 * background turns, so its chat's saved model outranks the session's pinned one.
 */
export const ROME_AGENT_TRAITS = {
  savedSelectionOutranksPin: [CONCIERGE_AGENT_ID],
} as const;
