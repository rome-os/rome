// The one place what a connection delivers inward passes. It asks the entry once
// for each, before any agent or app sees it.
// Vocabulary: docs/domains/participation.md#entry.

import { createLogger } from "../logger.js";
import type { EntryAccount, EntryPort } from "./entry.js";

const log = createLogger("entrance");

export interface Entrance<Person> {
  /** Whom a message is let in as, or nothing. The port that hears it marks it
   *  ({@link markEntered}), since it is recorded either way. */
  message(sender: EntryAccount): Promise<Person | undefined>;
}

export function entrance<Person>(entry: EntryPort<Person>): Entrance<Person> {
  const letIn = async (account: EntryAccount, what: string): Promise<{ person: Person } | null> => {
    const answer = await entry.enter(account);
    if (answer.kind === "entered") return { person: answer.person };
    log.debug("not let in", { what, ...account, entry: answer.kind });
    return null;
  };
  return {
    async message(sender) {
      return (await letIn(sender, "message"))?.person;
    },
  };
}

/** Whom an inbound event was let in as. A key of its own, so a copy of the
 *  event keeps it and no app can write it. */
const ENTERED = Symbol("entered");

/** `event`, marked with the person it was let in as. */
export function markEntered<Event extends object>(event: Event, person: unknown): Event {
  return person === undefined ? event : { ...event, [ENTERED]: person };
}

/** Whom `event` was let in as, as the host's entry named them, or nothing for
 *  one that was not. */
export function enteredAs<Person>(event: object): Person | undefined {
  return (event as { [ENTERED]?: Person })[ENTERED];
}
