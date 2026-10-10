import { defineAction, z, type Action, type ActionConfig } from "@rome-os/app-runtime";
import { hostExecutionError, hostJobResult, type HostExecutionDeps } from "../root-script.js";

export function createAction(config: ActionConfig, deps: HostExecutionDeps): Action {
  return defineAction({
    config,
    schema: z.strictObject({
      target: z.literal("hosting-vm"),
      operation: z.enum(["inspect", "cancel"]),
      jobId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
    }),
    execute: async ({ operation, jobId }) => {
      if (!deps.hostExecution) {
        return { status: "error", error: "Host execution is unavailable in this Rome runtime." };
      }
      try {
        return hostJobResult(await deps.hostExecution[operation](jobId));
      } catch (error) {
        return hostExecutionError(error);
      }
    },
  });
}
