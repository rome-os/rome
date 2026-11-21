/**
 * `system:show_app` — place an available app's widget on the guardian's workspace.
 *
 * The generic, app-agnostic form of a widget placement: the caller names which
 * `appId` to mount (an installed app or a host-owned app such as Sessions), and
 * optionally which `route` + scalar `params` to address. The app's web surface
 * appears as a tile on the freegrid beside the chat.
 *
 * Fire-and-forget: it returns `place_widget`, which the webchat drain loop turns
 * into a transient `widget_placement` event WITHOUT parking the agent (the turn
 * continues). The placement is keyed by `appId`, so calling again retargets the
 * same tile to the new route/params rather than stacking duplicates.
 *
 * Read-only and ungated by design — any agent granted this action can place any
 * installed app. The only enforced check is downstream: the drain loop drops the
 * placement (fail-closed) if `appId` is not actually installed.
 *
 * `route` is the app's own route (it rides the src path → `bootstrap.routePath`).
 * `params` are *addressing* (query keys read off `window.location.search`), not a
 * data payload. Structured data belongs in the target app's own session storage,
 * which the route reads on mount keyed by `session` + `params`.
 */

import { defineAction, z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";

export const showAppInputSchema = z.object({
  appId: z
    .string()
    .describe(
      'The available app to show, e.g. "workflow-studio" or the host-owned "sessions" app. If it is unavailable the placement is silently dropped.',
    ),
  route: z
    .string()
    .optional()
    .describe(
      'Optional route within the app to open, e.g. "orders/123" — the app\'s own router resolves it. The app handles an unknown route.',
    ),
  params: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      'Optional flat scalar params that further address the route (e.g. { tab: "history" }) — appended as query keys. Not a data payload; put data in the app\'s session storage.',
    ),
});

export type ShowAppInput = z.infer<typeof showAppInputSchema>;

export function createAction(_config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config: _config,
    schema: showAppInputSchema,
    // The widget is bound to THIS conversation: the host hands the app the chat
    // session over the global-params channel (the action never names it, so a
    // prompt-injected instruction can pick the app but not the workspace).
    execute: async ({ appId, route, params }) => ({
      status: "place_widget",
      placement: {
        appId,
        ...(route !== undefined ? { route } : {}),
        ...(params !== undefined ? { params } : {}),
      },
    }),
  });
}
