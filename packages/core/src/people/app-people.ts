// The `PeopleService` `@rome-os/app-runtime` publishes to apps, answered from
// People's repository. Vocabulary: docs/domains/people.md.

import type { PeopleService } from "@rome-os/app-runtime";
import type { PeopleRepository } from "../db/repositories/people.js";

export function appPeople(people: Pick<PeopleRepository, "byBondLevel">): PeopleService {
  return {
    async guardian() {
      const guardians = await people.byBondLevel("guardian");
      // A delegate link is an agent's account acting for the guardian, so a
      // direct message there reaches the agent, not the guardian.
      const accounts = guardians.flatMap((guardian) =>
        guardian.links
          .filter((link) => !link.delegate)
          .map(({ platform, id }) => ({ platform, id })),
      );
      return { accounts };
    },
  };
}
