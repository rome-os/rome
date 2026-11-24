// What a connection hands Rome when someone runs a command on a platform, and
// how the command is answered. Vocabulary: docs/domains/connections.md#command.
//
// The connection puts the commands it is given on the platform, reports each
// one someone runs in the platform's own ids, and delivers the answer it gets
// back. It never decides who may run a command, what a command means, or
// what the answer says.

import type { MessageSender, MessageWhere } from "./message.js";

/** One command someone ran, as the platform reported it. */
export interface Command {
  /** The chat it was run in. */
  readonly where: Pick<MessageWhere, "chatId" | "kind" | "name" | "thread">;
  /** Who ran it. */
  readonly sender: Pick<MessageSender, "accountId" | "name">;
  /** The account the platform delivered it to: the connection's own. */
  readonly receivedBy: string;
  /** The command's name, then each subcommand's: `["channel", "agent", "set"]`. */
  readonly path: readonly string[];
  /** Each option given, by its name, as typed or picked. */
  readonly options: Readonly<Record<string, string>>;
}

/** An option a command takes. */
export interface CommandOptionSpec {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  /** The only values it takes, where it takes a fixed set. */
  readonly choices?: readonly string[];
  /** Whether the platform asks for suggestions while it is typed. */
  readonly suggested?: boolean;
}

/** A command a connection offers on its platform. A command has either
 *  subcommands or options. */
export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly CommandOptionSpec[];
  readonly subcommands?: readonly CommandSpec[];
}

/**
 * The commands a connection offers, and who answers them. A connection given
 * these puts `list` on its platform, and reports each command run there.
 */
export interface Commands {
  readonly list: readonly CommandSpec[];
  /** The answer to `command`, as text for the person who ran it. */
  ran(command: Command): Promise<string>;
  /** Values to suggest for option `option` of `command` while it is typed,
   *  `typed` being what is typed so far. */
  suggest(command: Command, option: string, typed: string): Promise<readonly string[]>;
}
