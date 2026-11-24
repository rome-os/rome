// Who may act with the guardian's access where a message was said: the one
// answer the wake rule and the Concierge read on a connection. Access control
// replaces its body with a list of allowed teammates.

/** What decides it: whether the account the message reached serves its
 *  whole workspace (docs/domains/participation.md#workspace-account), and
 *  whether the sender is the guardian, as the caller already tells. */
export interface GuardianAccessAsk {
  servesWorkspace: boolean;
  guardian: boolean;
}

/**
 * Whether the sender may act with the guardian's access there: the guardian
 * may, and on an account that serves its workspace anyone it hears may
 * (Ouou, 2026-11-24).
 */
export function actsWithGuardianAccess(ask: GuardianAccessAsk): boolean {
  return ask.guardian || ask.servesWorkspace;
}
