import type {
  Action,
  ActionConfig,
  ActionResult,
  AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { readConfig, TICK_ROUTINE_KEY, type EngineerConfig } from "../../lib/config.js";

/**
 * What the action answers. `configured` is false whenever there is no
 * repository to work on: either no tick routine is registered, or the one that
 * is carries args that no longer read as a config, and `reason` says which.
 *
 * { configured: true, repo: "acme/widgets", label: "engineer", projectPath: "/projects/acme-widgets", … }
 */
export type ConfigOutput =
  | ({ configured: true } & EngineerConfig)
  | { configured: false; reason?: string };

/**
 * Reads the config back out of the tick routine's args, so an agent turn that
 * carries no prompt of its own — a fresh chat with the guardian — can learn the
 * repository instead of asking for it.
 *
 * The tick routine is the single source of truth. The daily-report routine
 * holds the same args, but a config the tick does not run on is not the config
 * the bot works under.
 */
export function createConfigAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  const { appContext } = deps;

  return {
    config,
    // An action with no inputSchema is not agent-callable, so this action takes
    // no arguments and still declares a schema.
    inputSchema: { type: "object", properties: {} },

    async execute(): Promise<ActionResult> {
      const routines = await appContext.listRoutines();
      const tick = routines.find((routine) => routine.key === TICK_ROUTINE_KEY);
      if (!tick) {
        return { status: "ok", data: { configured: false } satisfies ConfigOutput };
      }

      const parsed = readConfig(tick.args ?? {});
      if (!parsed.ok) {
        return {
          status: "ok",
          data: { configured: false, reason: parsed.error } satisfies ConfigOutput,
        };
      }

      return {
        status: "ok",
        data: { configured: true, ...parsed.config } satisfies ConfigOutput,
      };
    },
  };
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return createConfigAction(config, deps);
}
