// The one place what a connection delivers inward passes: a message, a command
// or a press. It asks the entry once for each, before any agent or app sees it,
// and hands on only what someone let in said or did.
// Vocabulary: docs/domains/participation.md#entry.

import { createLogger } from "../logger.js";
import type { EntryAccount, EntryPort } from "./entry.js";

const log = createLogger("entrance");

/** Why whoever ran a command gets no answer to it, shown only to them. */
const COMMAND_REFUSED = "Only the guardian and members of this Rome can run its commands.";

/** Commands a connection reports, as `connections/command.ts` describes them. */
interface RunCommands<C> {
  ran(command: C): Promise<string>;
  suggest(command: C, option: string, typed: string): Promise<readonly string[]>;
}

export interface Entrance<Person> {
  /** Whom a message is let in as, or nothing. The port that hears it marks it
   *  ({@link markEntered}), since it is recorded either way. */
  message(sender: EntryAccount): Promise<Person | undefined>;
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
    commands(platform, commands) {
      const ranByOneLetIn = async (command: { sender: { accountId: string } }) =>
        (await letIn({ platform, id: command.sender.accountId }, "command")) !== null;
      return {
        ...commands,
        ran: async (command) =>
          (await ranByOneLetIn(command)) ? commands.ran(command) : COMMAND_REFUSED,
        suggest: async (command, option, typed) =>
          (await ranByOneLetIn(command)) ? commands.suggest(command, option, typed) : [],
      };
    },
    async press(presser, answer) {
      if (await letIn(presser, "press")) await answer();
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
