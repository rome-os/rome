// An app's `ctx.access`, answered by Access's application layer
// (docs/domains/access.md).

import type { Access } from "@rome-os/app-runtime";
import { guardianWithAccounts, memberContext } from "../access/application/members.js";
import type { DrizzleDb } from "../db/index.js";

/** `ctx.access` over `db`. */
export function appAccess(db: DrizzleDb): Access {
  return {
    async guardianAccounts() {
      const guardian = await guardianWithAccounts(memberContext(db));
      return (guardian?.accounts ?? []).map(({ platform, accountId }) => ({
        platform,
        id: accountId,
      }));
    },
  };
}
