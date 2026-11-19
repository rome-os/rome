// What the phone book needs from the rest of Rome, for its routes and its
// actions alike. The wiring fills it in.

import type { PeopleRepository } from "../model/people-repository.js";
import type { AccountDecisionDeps } from "./account-decisions.js";
import type { PeopleWriteDeps } from "./create.js";
import type { PeopleDeleteDeps } from "./delete.js";
import type { PeopleMergeDeps } from "./merge.js";
import type { PeopleUpdateDeps } from "./update.js";

export type PhoneBookDeps = PeopleWriteDeps &
  PeopleUpdateDeps &
  PeopleMergeDeps &
  PeopleDeleteDeps &
  AccountDecisionDeps & {
    peopleRepo: Pick<PeopleRepository, "link" | "move" | "unlink">;
  };
