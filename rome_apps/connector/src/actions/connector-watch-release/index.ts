import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

const inputSchema = z.object({
  source: z.string(),
  target: z.string().optional(),
  consumer: z.string(),
});

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async () => ({
      status: "ok",
      data: {
        released: false,
        reason: "Shared subscriptions are not counted yet (rome-os/rome#1658).",
      },
    }),
  });
}
