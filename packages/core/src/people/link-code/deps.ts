// What the link code needs from the rest of Rome, and nothing more.

import type { GuardianLinkCodes } from "./application/guardian-link-code.js";

export interface LinkCodeDeps {
  /** The codes the guardian has been issued. Discord and Feishu redeem them
   *  from the same instance. */
  guardianLinkCodes: Pick<GuardianLinkCodes, "issue">;
  /** Whether the request being served is the guardian's own session. */
  isGuardian(): Promise<boolean>;
}
