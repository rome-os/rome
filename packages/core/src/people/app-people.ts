// The `PeopleService` `@rome-os/app-runtime` publishes to apps, answered from
// the guardian's accounts in Identity. Vocabulary: docs/domains/access.md.

import type { Access, PeopleService } from "@rome-os/app-runtime";

/** `PeopleService` over `access`, which answers the guardian's accounts. */
export function appPeople(access: Pick<Access, "guardianAccounts">): PeopleService {
  return {
    async guardian() {
      return { accounts: await access.guardianAccounts() };
    },
  };
}
