import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

const log = createAppLogger("__APP_ID__:hello");

const helloInputSchema = z.object({
  message: z.string().optional().describe("Optional note to record"),
});

export function createAction(config: ActionConfig, _runtime: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: helloInputSchema,
    execute: async ({ message }) => {
      const greeting = message ?? "hello, world";
      log.info("hello action invoked", { greeting });
      // To persist greetings, enable the `db` section in app.yaml and use
      // createHelloRepository(runtime.appContext.db) — see src/db/README.md.
      return { status: "ok", data: { message: greeting } };
    },
  });
}
