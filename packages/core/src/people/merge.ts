// Merging one person into another: the duplicate's links move, the duplicate
// dies, and the survivor answers with every account they now hold.
//
// Here rather than in the route because which merges are refused is a contract
// decision, not an HTTP one. The transaction itself is the person repository's,
// because only a transaction there can read both rows and move the links
// without another writer landing in between; this turns the reason it gives
// back into the sentence a caller reads.
//
// What a merge does NOT touch: the merged-away person's profile file in the
// relationship directory, and anything else written in memory. A filesystem
// write cannot join the transaction the links move in, so folding the prose in
// here would reintroduce the half-done state merge exists to rule
// out — and concatenating two hand-written profiles states both sides of every
// disagreement as fact. The file stays where it is, unreferenced and readable,
// for the guardian or the agent to fold in as prose.

import { type PersonResource } from "@rome/api-types/people";
import type { MergeRefusal, PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { readPerson, type PeopleReadDeps } from "./resource.js";

export interface PeopleMergeDeps extends PeopleReadDeps {
  personMappingRepo: PeopleReadDeps["personMappingRepo"] &
    Pick<PersonMappingRepository, "mergePersons">;
}

/**
 * The survivor, or why the merge did not happen: `unknown` for an id that
 * names nobody a caller may address, and `refused` for a person who exists and
 * is staying where they are.
 */
export type MergePeopleResult =
  | { person: PersonResource }
  | { unknown: true }
  | { refused: string };

/**
 * Move every account `from` holds onto `into`, then delete `from`.
 *
 * First-class rather than N transfers and a delete: each of those steps
 * re-attributes a slice of history, and a merge that stops halfway leaves the
 * guardian with two people who each hold part of one person's past.
 *
 * The stranger sentinel is addressable on neither side. It is the row every
 * dismissal maps onto rather than someone the guardian knows, so a caller
 * naming it gets the answer every other route gives for it — nobody is there.
 */
export async function mergePeople(
  deps: PeopleMergeDeps,
  into: string,
  from: string,
): Promise<MergePeopleResult> {
  const result = await deps.personMappingRepo.mergePersons(into, from);
  if (!result.merged) return refusal(result.reason);

  const person = await readPerson(deps, into);
  if (!person) throw new Error(`person ${into} does not read back after merging ${from}`);
  return { person };
}

/** The sentence a refused merge answers with, from the rule that refused it. */
function refusal(reason: MergeRefusal): MergePeopleResult {
  switch (reason) {
    // An id naming nobody and an id naming structure read alike from outside:
    // the sentinel is not a person a caller may merge or merge away, and
    // saying so in different words would tell a caller it exists.
    case "unknown-target":
    case "unknown-source":
    case "sentinel-target":
    case "sentinel-source":
      return { unknown: true };
    case "guardian-source":
      return { refused: "the guardian cannot be merged away" };
    case "same-person":
      return { refused: "a person cannot be merged into themselves" };
  }
}
