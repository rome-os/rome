// The phone book's listing: every curated person a search matches, narrowed to
// one bond level, with the numbers each level's filter shows. How a search
// matches, how people order and what the numbers count are the contract's
// (@rome/api-types/people).

import {
  comparePeople,
  countPeople,
  personMatchesLevel,
  personMatchesQuery,
  type PeopleList,
  type PersonFilterLevel,
} from "@rome/api-types/people";
import { readPeople, type PeopleReadDeps } from "./resource.js";

/** What to list: a search over names and accounts, and a bond level or "all". */
export interface PeopleQuery {
  query?: string;
  level?: PersonFilterLevel;
}

export async function listPeople(deps: PeopleReadDeps, query: PeopleQuery): Promise<PeopleList> {
  // The whole search match, before the level narrows it: the counts describe
  // it, and every level's number has to stay true while another level is the
  // one shown.
  const matching = (await readPeople(deps)).filter((person) =>
    personMatchesQuery(person, query.query ?? ""),
  );
  return {
    people: matching
      .filter((person) => personMatchesLevel(person, query.level ?? "all"))
      .sort(comparePeople),
    counts: countPeople(matching),
  };
}
