import { defineAction, z, type Action, type ActionConfig } from "@rome-os/app-runtime";
import { hostExecutionError, hostJobResult, type HostExecutionDeps } from "../root-script.js";

export const executeRootScriptInputSchema = z.strictObject({
  target: z
    .literal("hosting-vm")
    .describe("The Linux VM hosting this Rome container. Runs as host root."),
  interpreter: z.enum(["sh", "bash"]),
  script: z
    .string()
    .min(1)
    .max(65_536)
    .describe(
      "Noninteractive shell script, at most 64 KiB UTF-8. Runs with a minimal host environment.",
    ),
  reason: z.string().trim().min(1).max(2_000).describe("Why this host-root operation is needed."),
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
  __triggerPayload: z.unknown().optional(),
});

export function createAction(config: ActionConfig, deps: HostExecutionDeps): Action {
  return defineAction({
    config,
    schema: executeRootScriptInputSchema,
    execute: async ({ __triggerPayload: _triggerPayload, ...input }) => {
      if (!deps.hostExecution) {
        return { status: "error", error: "Host execution is unavailable in this Rome runtime." };
      }
      if (Buffer.byteLength(input.script) > 65_536) {
        return { status: "error", error: "The script exceeds the 64 KiB UTF-8 limit." };
      }
      try {
        return hostJobResult(await deps.hostExecution.start(input));
      } catch (error) {
        return hostExecutionError(error);
      }
    },
  });
}
