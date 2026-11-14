// The agent's way to read who a person is: their bond level, accounts and the
// notes the guardian keeps on them. Vocabulary: docs/domains/people.md.

import { readFile } from "node:fs/promises";
import { actionExecutionContext } from "../apps/actions/context.js";
import type { ActionRegistry } from "../apps/actions/types.js";
import type { PeopleRepository, Person } from "../db/repositories/people.js";
import { resolveProfileMemoryPath } from "../profile-memory.js";

export const READ_PERSON_ACTION = "core:read_person";

/** A person as the agent reads them. `notes` is null when the guardian keeps
 *  none on them. */
export interface PersonAsRead {
  name: string;
  bondLevel: Person["bondLevel"];
  accounts: { platform: string; id: string; delegate?: true }[];
  notes: string | null;
}

/** Registers `core:read_person`, which the agent calls to learn who someone
 *  it does not recognize is. */
export function registerReadPersonAction(
  actions: Pick<ActionRegistry, "register">,
  deps: {
    people: Pick<PeopleRepository, "all">;
    /** The notes file at `profilePath`, or null when there is none. */
    readNotes?: (profilePath: string) => Promise<string | null>;
  },
): void {
  const readNotes = deps.readNotes ?? readNotesFile;
  actions.register({
    config: {
      name: READ_PERSON_ACTION,
      type: "system",
      description:
        "Read who a person is: their bond level, their accounts, and the guardian's notes on them. Call it when a message comes from, or mentions, someone you do not recognize. Pass the person's name as a message's sender label shows it in parentheses, such as `Ana Lopez` from `Ana (Ana Lopez, inner circle)`. A sender marked `not linked` is nobody the guardian tracks and has no notes.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "The person's name, matched ignoring case." },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      // The notes are the guardian's own. A visitor's chat, or a request with
      // no session, never reads them.
      const actor = actionExecutionContext.getStore()?.actor;
      if (actor && actor.kind !== "guardian") {
        return { status: "error", error: "Only the guardian's agents can read a person's notes." };
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return { status: "error", error: "Pass the person's name." };
      const wanted = name.toLowerCase();
      const matches = (await deps.people.all()).filter(
        (person) => person.displayName.trim().toLowerCase() === wanted,
      );
      const people: PersonAsRead[] = await Promise.all(
        matches.map(async (person) => ({
          name: person.displayName,
          bondLevel: person.bondLevel,
          accounts: person.links.map(({ platform, id, delegate }) => ({
            platform,
            id,
            ...(delegate ? { delegate } : {}),
          })),
          notes: person.profilePath ? await readNotes(person.profilePath) : null,
        })),
      );
      return { status: "ok", data: { people } };
    },
  });
}

async function readNotesFile(profilePath: string): Promise<string | null> {
  try {
    const notes = (await readFile(resolveProfileMemoryPath(profilePath), "utf8")).trim();
    return notes || null;
  } catch {
    return null;
  }
}
