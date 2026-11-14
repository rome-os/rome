// `core:user_data_catalog` and `core:user_data_query`: how an Agent reads user
// data. Both are personal-data actions, so they run only in a private turn
// (docs/domains/participation.md#audience). Contract: docs/user-data.md#agent-access.

import type { ActionRegistry } from "../apps/actions/types.js";
import { queryInputSchema } from "./domain/query.js";
import { queryUserData } from "./read.js";
import type { UserDataRepository } from "./repository.js";
import { sourceSpec, USER_DATA_SOURCES } from "./sources/index.js";

export const USER_DATA_CATALOG_ACTION = "core:user_data_catalog";
export const USER_DATA_QUERY_ACTION = "core:user_data_query";

const STORED_FIRST =
  "Read stored data first. Use the live device path only when the stored data does not cover what " +
  "you need (freshness.coversWindow is false and the question needs the latest hours) and the device " +
  "is online. Otherwise answer from stored data and say how fresh it is.";

export interface UserDataActionDeps {
  userData: UserDataRepository;
  /** The guardian's time zone, the default zone of a query. */
  guardianTimeZone: () => Promise<string>;
  now?: () => number;
}

export function registerUserDataActions(
  actions: Pick<ActionRegistry, "register">,
  deps: UserDataActionDeps,
): void {
  const now = deps.now ?? Date.now;
  actions.register({
    config: {
      name: USER_DATA_CATALOG_ACTION,
      type: "system",
      description:
        "List the guardian's personal data that their devices sync to Rome, such as Apple Health: " +
        "each source, the device it comes from, when it last synced, and each type with its unit, " +
        `range and how far it is synced. Call it before ${USER_DATA_QUERY_ACTION}. ${STORED_FIRST} ` +
        "Runs only in a private chat with the guardian.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ status: "ok", data: { sources: deps.userData.catalog() } }),
  });

  const sourceNames = USER_DATA_SOURCES.map((source) => source.source);
  actions.register({
    config: {
      name: USER_DATA_QUERY_ACTION,
      type: "system",
      description:
        "Aggregate or list the guardian's synced personal data, such as Apple Health steps, sleep, " +
        "heart rate or workouts, over a time window. The input and reply follow the iPhone's " +
        "health.stats: types, start, end, interval, aggregate, unit. A bucket with no value is left " +
        "out, never 0. Week, month and total averages are the mean of daily averages " +
        `(aggregate avg_of_days). The reply's freshness says how far each type is synced. ${STORED_FIRST} ` +
        "Runs only in a private chat with the guardian.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: {
          type: "string",
          enum: sourceNames,
          description: "The source, such as apple_health.",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description: "Types to read, such as stepCount and sleep. Send types or type.",
        },
        type: { type: "string", description: "One type to read." },
        start: {
          type: "string",
          description:
            "ISO 8601 time, with or without offset (without one, in timeZone), or YYYY-MM-DD in timeZone. Default: today from local midnight.",
        },
        end: {
          type: "string",
          description: "As start; a date means the end of that day. Default: now.",
        },
        timeZone: {
          type: "string",
          description: "IANA zone for dates and buckets. Default: the guardian's time zone.",
        },
        interval: {
          type: "string",
          enum: ["total", "hour", "day", "week", "month"],
          description: "Bucket width, at most 1000 buckets. Default: total.",
        },
        aggregate: {
          type: "string",
          enum: ["sum", "avg", "min", "max", "latest"],
          description:
            "Default: sum for cumulative types such as stepCount, avg for the rest. latest does not fit cumulative types, sum does not fit averaged ones.",
        },
        unit: { type: "string", description: "Convert to this unit, such as km, kJ, lb or degF." },
        records: {
          type: "object",
          description:
            "For one sample or record type (sleep, workouts, body readings): list the records instead of aggregating.",
          properties: {
            limit: { type: "integer", description: "At most 500. Default 100." },
            cursor: { type: "string", description: "The nextCursor of the previous page." },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = queryInputSchema.safeParse(args);
      if (!input.success) {
        const issue = input.error.issues[0];
        return {
          status: "error",
          error: `Invalid input${issue?.path.length ? ` at ${issue.path.join(".")}` : ""}: ${issue?.message}`,
        };
      }
      const source = sourceSpec(input.data.source);
      if (!source) {
        return {
          status: "error",
          error: `Unknown source "${input.data.source}". Sources: ${sourceNames.join(", ")}.`,
        };
      }
      const answer = queryUserData(deps.userData, source, input.data, {
        tz: await deps.guardianTimeZone(),
        now: now(),
      });
      if ("error" in answer) return { status: "error", error: answer.error };
      return { status: "ok", data: answer };
    },
  });
}
