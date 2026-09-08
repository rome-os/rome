import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { loadTask, rejectIfClosed, writePersonFact } from "../../lib/person-fact.js";

/** A person closes the task as not wanted. Terminal, like complete. */
export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task to drop. Read it from manager:snapshot." },
        reason: { type: "string", description: "Why it is dropped, if the person said." },
        source: {
          type: "string",
          description: "The person's message, verbatim. Recorded as the fact's citation.",
        },
      },
      required: ["taskId", "source"],
      additionalProperties: false,
    },

    async execute(args): Promise<ActionResult> {
      const taskId = String(args.taskId ?? "").trim();
      const source = String(args.source ?? "").trim();
      const reason = typeof args.reason === "string" ? args.reason.trim() : undefined;
      if (!taskId) return { status: "error", error: "taskId is required" };
      if (!source) {
        return { status: "error", error: "source is required: pass the person's message verbatim" };
      }

      const found = loadTask(appContext, taskId);
      if (!found.ok) return { status: "error", error: found.error };
      const closed = rejectIfClosed(found.task);
      if (closed) return { status: "error", error: closed };

      return await writePersonFact(appContext, {
        taskId,
        kind: "Cancelled",
        source,
        payload: reason ? { reason } : {},
      });
    },
  };
}
