// A connection signed in as the guardian's own account makes that account the
// guardian's at once, with no code. Vocabulary: docs/domains/access.md.

import type { DrizzleTx } from "../../db/index.js";
import { giveGuardian, memberContextWithinTx } from "./members.js";

/** A connect signed in as the account that gave Rome the access. */
interface OwnAccountConnect {
  platform: string;
  accountId: string;
}

/**
 * Joins each connect signed in as the account that gave Rome the access, and
 * gives that account to the guardian in Identity inside the credential's
 * transaction, as {@link giveGuardian} does. A throw fails the connect and
 * leaves the credential unsaved. Nothing is given while Rome has no guardian.
 */
export function ownAccountConnected(): {
  prepare(connect: OwnAccountConnect): Promise<(tx: DrizzleTx) => void>;
} {
  return {
    async prepare({ platform, accountId }) {
      return (tx) => {
        const { identity, access } = memberContextWithinTx(tx);
        const guardian = access.members().find((member) => member.role === "guardian");
        if (guardian) giveGuardian(identity, guardian.personId, { platform, accountId });
      };
    },
  };
}
