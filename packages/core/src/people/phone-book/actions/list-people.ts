// The phone book for agents: the same listing the People page reads, through
// the same use case.

import type { Action } from "@rome-os/app-runtime";
import { PERSON_BOND_LEVELS, parsePersonFilterLevel } from "@rome/api-types/people";
import { type OwnerOfChat, runsForGuardian } from "../../actions/guardian-only.js";
import { listPeople } from "../application/list.js";
import type { PeopleReadDeps } from "../application/resource.js";

export const LIST_PEOPLE_ACTION = "core:list_people";

export function listPeopleAction(deps: PeopleReadDeps & { ownerOfChat: OwnerOfChat }): Action {
  return {
    config: {
      name: LIST_PEOPLE_ACTION,
      type: "system",
      description:
        "List the people in the guardian's phone book, with their bond levels and accounts, and how many there are at each level. Pass `query` to search names and accounts, and `level` to keep one bond level.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match against names and accounts." },
        level: {
          type: "string",
          enum: ["all", ...PERSON_BOND_LEVELS],
          description: 'A bond level to keep, or "all". Defaults to "all".',
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      if (!(await runsForGuardian(deps.ownerOfChat))) {
        return { status: "error", error: "Only the guardian's agents can read the phone book." };
      }
      const rawLevel = typeof args.level === "string" ? args.level : undefined;
      const level = parsePersonFilterLevel(rawLevel);
      if (rawLevel && level === null) {
        return { status: "error", error: 'level must name a bond level or "all".' };
      }
      const query = typeof args.query === "string" ? args.query : undefined;
      return { status: "ok", data: await listPeople(deps, { query, level: level ?? "all" }) };
    },
  };
}
