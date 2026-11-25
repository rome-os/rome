// The one place what a connection delivers inward passes. It asks the entry once
// for each, before any agent or app sees it.
// Vocabulary: docs/domains/participation.md#entry.

import { createLogger } from "../logger.js";
import type { Entry, EntryAccount, EntryPort } from "./entry.js";

const log = createLogger("entrance");

export interface Entrance<Person> {
  /** Whether a message's sender is let in, and as whom. The port that hears the
   *  message marks it ({@link markArrival}), since it is recorded either way. */
  message(sender: EntryAccount): Promise<Entry<Person>>;
}

export function entrance<Person>(entry: EntryPort<Person>): Entrance<Person> {
  return {
    async message(sender) {
      const answer = await entry.enter(sender);
      if (answer.kind !== "entered") log.debug("not let in", { ...sender, entry: answer.kind });
      return answer;
    },
  };
}

/** What Rome knows of an inbound event's sender as it arrives. */
export interface Arrival<Person = unknown> {
  readonly entry: Entry<Person>;
  /** The platform says a bot or an app posted it. */
  readonly automated: boolean;
}

/** A key of its own, so a copy of the event keeps it and no app can write it. */
const ARRIVAL = Symbol("arrival");

/** `event`, marked with what is known of its sender. */
export function markArrival<Event extends object>(event: Event, arrival: Arrival): Event {
  return { ...event, [ARRIVAL]: arrival };
}

/** What `event` was marked with, or nothing for one no entrance saw. */
export function arrivalOf<Person>(event: object): Arrival<Person> | undefined {
  return (event as { [ARRIVAL]?: Arrival<Person> })[ARRIVAL];
}

/** Whom `event` was let in as, or nothing for one that was not. */
export function enteredAs<Person>(event: object): Person | undefined {
  const entry = arrivalOf<Person>(event)?.entry;
  return entry?.kind === "entered" ? entry.person : undefined;
}
