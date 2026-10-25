// A grant names the account it reaches. Model:
// docs/domains/connections.md#grant.

import { domainOfGrants, platformOf } from "../channels/platform.js";
import { createLogger } from "../logger.js";
import type { GrantAccount } from "./ledger.js";
import type { ConnectionRegistry } from "./registry.js";

const log = createLogger("connections");

/**
 * Record the account each held grant reaches, for the boot pass. A grant
 * conferred before grants named their account holds a profile and no account.
 * The oldest connection keeps an account two connections reach, and the other
 * grant is logged and left without one, as is a grant the ledger refuses.
 * Answers how many grants it recorded.
 */
export async function recordGrantAccounts(
  registry: Pick<ConnectionRegistry, "getDescriptor" | "getLedger">,
): Promise<number> {
  const ledger = registry.getLedger();
  const connections = (await ledger.listConnections()).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  let recorded = 0;
  for (const conn of connections) {
    const accountIdOf = registry.getDescriptor(conn.connectionKind)?.accountIdOf;
    if (!accountIdOf) continue;
    for (const grant of await ledger.listGrants(conn.id)) {
      if (grant.account || !grant.profile || grant.state === "unauthorized") continue;
      const accountId = accountIdOf(grant.name, grant.profile);
      if (!accountId) continue;
      // A Feishu grant from before profiles names its domain only in its material.
      const account: GrantAccount = {
        platform: platformOf(conn.connectionKind, domainOfGrants([grant])),
        accountId,
      };
      try {
        const other = await ledger.connectionReaching(account, conn.id);
        if (other) {
          log.warn("a grant reaches an account another connection reaches", {
            id: conn.id,
            grant: grant.name,
            other,
          });
          continue;
        }
        await ledger.updateGrant(conn.id, grant.name, { account });
        recorded++;
      } catch (error) {
        // A row the ledger refuses must not keep Rome from starting.
        log.warn("could not record the account a grant reaches", {
          id: conn.id,
          grant: grant.name,
          error,
        });
      }
    }
  }
  if (recorded > 0) log.info("recorded the accounts grants reach", { recorded });
  return recorded;
}
