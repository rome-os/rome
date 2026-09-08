import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { writePersonFact } from "../../lib/person-fact.js";

/** Opens a task with a Created fact. The only way a task comes into being. */
export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        brief: {
          type: "string",
          description: "What the task is, in a sentence or two. This becomes the worker's brief.",
        },
        source: {
          type: "string",
          description: "The person's message, verbatim. Recorded as the fact's citation.",
        },
      },
      required: ["brief", "source"],
      additionalProperties: false,
    },

    async execute(args): Promise<ActionResult> {
      const brief = String(args.brief ?? "").trim();
      const source = String(args.source ?? "").trim();
      if (!brief) return { status: "error", error: "brief is required" };
      if (!source) {
        return {
          status: "error",
          error: "source is required: pass the person's message verbatim",
        };
      }

      const taskId = `t-${crypto.randomUUID().slice(0, 8)}`;
      return await writePersonFact(appContext, {
        taskId,
        kind: "Created",
        source,
        payload: { brief },
      });
    },
  };
}
