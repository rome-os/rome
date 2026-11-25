// The one place what a connection delivers inward passes: a message, a command
// or a press. It asks the entry once for each, before any agent or app sees it,
// and hands on only what someone let in said or did.
// Vocabulary: docs/domains/participation.md#entry.

import { createLogger } from "../logger.js";
import type { Entry, EntryAccount, EntryPort } from "./entry.js";

const log = createLogger("entrance");

/** Why whoever ran a command gets no answer to it, shown only to them. */
const COMMAND_REFUSED = "Only the guardian and members of this Rome can run its commands.";

/** Commands a connection reports, as `connections/command.ts` describes them. */
interface RunCommands<C> {
  ran(command: C): Promise<string>;
  suggest(command: C, option: string, typed: string): Promise<readonly string[]>;
}

export interface Entrance<Person> {
  /** Whether a message's sender is let in, and as whom. The port that hears the
   *  message marks it ({@link markArrival}), since it is recorded either way. */
  message(sender: EntryAccount): Promise<Entry<Person>>;
  /** `commands`, reached only by someone let in. Anyone else is told so and
   *  gets no suggestions. `platform` is the one the commands are run on. */
  commands<C extends { sender: { accountId: string } }, All extends RunCommands<C>>(
    platform: string,
    commands: All & RunCommands<C>,
  ): All;
  /** Runs `answer` to a press when whoever pressed is let in, else nothing. */
  press(presser: EntryAccount, answer: () => Promise<void>): Promise<void>;
}

export function entrance<Person>(entry: EntryPort<Person>): Entrance<Person> {
  const ask = async (account: EntryAccount, what: string): Promise<Entry<Person>> => {
    const answer = await entry.enter(account);
    if (answer.kind !== "entered") {
      log.debug("not let in", { what, ...account, entry: answer.kind });
    }
    return answer;
  };
  return {
    message: (sender) => ask(sender, "message"),
    commands(platform, commands) {
      const ranByOneLetIn = async (command: { sender: { accountId: string } }) =>
        (await ask({ platform, id: command.sender.accountId }, "command")).kind === "entered";
      return {
        ...commands,
        ran: async (command) =>
          (await ranByOneLetIn(command)) ? commands.ran(command) : COMMAND_REFUSED,
        suggest: async (command, option, typed) =>
          (await ranByOneLetIn(command)) ? commands.suggest(command, option, typed) : [],
      };
    },
    async press(presser, answer) {
      if ((await ask(presser, "press")).kind === "entered") await answer();
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
