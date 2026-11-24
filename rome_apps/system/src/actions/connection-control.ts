import { defineAction } from "@rome-os/app-runtime";
import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
  PreviewPayload,
} from "@rome-os/app-runtime";
import type { z } from "@rome-os/app-runtime";

// The connection actions are thin: core runs each one (connections/control.ts),
// shared with the Connections page, and these actions declare the input agents
// read and hand it over.

/** Core's connection operations: the main process's own, or a worker's call
 * to it. It reads who asks from the running action. */
export interface ConnectionControlService {
  call(op: string, input: unknown): Promise<ActionResult>;
}

export interface ConnectionControlDeps {
  connectionControl: ConnectionControlService;
}

/** The action that hands its input to core's operation `op`. `previewOp`
 * names core's operation that words its approval card. */
export function connectionControlAction(
  op: string,
  schema: z.ZodType,
  config: ActionConfig,
  deps: AppActionRuntimeDeps<ConnectionControlDeps>,
  previewOp?: string,
): Action {
  // The deps bag is untyped at the wiring seam; a missing dep must fail the
  // action load at boot, not on first invocation.
  if (typeof deps.connectionControl?.call !== "function") {
    throw new Error(`${config.name} requires a connectionControl dep`);
  }
  const action = defineAction({
    config,
    schema,
    execute: (input) => deps.connectionControl.call(op, input),
  });
  if (!previewOp) return action;
  return {
    ...action,
    // defineAction takes only a preview it can word itself; core words this
    // one from the connection it names.
    preview: async (args): Promise<PreviewPayload> => {
      const result = await deps.connectionControl.call(previewOp, args);
      return result.status === "ok"
        ? (result.data as PreviewPayload)
        : {
            kind: "generic",
            title: "Disconnect a connection",
            summary: result.status === "error" ? result.error : "",
          };
    },
  };
}
