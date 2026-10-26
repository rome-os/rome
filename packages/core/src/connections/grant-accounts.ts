// A grant names the account it reaches. Model:
// docs/domains/connections.md#grant.

import { createLogger } from "../logger.js";
import { type ConnectionRegistry, reachedAccount } from "./registry.js";

const log = createLogger("connections");

/**
 * Record the account each held grant reaches, for the boot pass. A grant
 * conferred before grants named their account holds a profile and no account.
 * The oldest connection keeps an account two connections reach, and the other
 * grant is logged and left without one, as is a grant the store refuses.
 * Answers how many grants it recorded.
 */
export async function recordGrantAccounts(
  registry: Pick<ConnectionRegistry, "getDescriptor" | "getRepository">,
): Promise<number> {
  const store = registry.getRepository();
  let recorded = 0;
  for (const conn of await store.all()) {
    const descriptor = registry.getDescriptor(conn.connectionKind);
    if (!descriptor) continue;
    const grant = conn.grant;
    if (grant.account || grant.state === "unauthorized") continue;
    const account = reachedAccount(descriptor, grant);
    if (!account) continue;
    try {
      const other = await store.reaching(account, conn.id);
      if (other) {
        log.warn("a grant reaches an account another connection reaches", { id: conn.id, other });
        continue;
      }
      await store.update(conn.id, (current) => ({
        ...current,
        grant: { ...current.grant, account },
      }));
      recorded++;
    } catch (error) {
      // A grant the store refuses must not keep Rome from starting.
      log.warn("could not record the account a grant reaches", { id: conn.id, error });
    }
  }
  if (recorded > 0) log.info("recorded the accounts grants reach", { recorded });
  return recorded;
}
