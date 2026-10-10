import { z } from "zod";
import { useSseEvents } from "./use-sse-events";

const catalogChangeSchema = z.object({
  appId: z.string(),
  change: z.enum(["added", "changed", "removed"]),
});

/**
 * Subscribes the open embedded app view to the guardian-gated catalog-change
 * stream (`GET /api/apps/events`, revived in #1646) and pokes `onChange`
 * whenever the app it is displaying changes (#1640).
 *
 * `onChange` fires on two triggers:
 *  - a `catalog-change` frame whose `appId` matches this view's app, and
 *  - each stream reconnect after the initial open — a catch-up so a change
 *    that landed while the stream was down is reflected once it reconnects.
 *
 * No branching on change type: any matching event is a "something changed,
 * re-derive from the manifest" poke; the caller refetches and lets the manifest
 * response drive the outcome.
 *
 * The connection opens only when `enabled` is true. The caller passes the
 * manifest-derived guardian check, so visitor/anonymous views never open a
 * stream the backend would only reject. Native EventSource reconnection covers
 * transient drops, so a brief blip stays invisible.
 */
export function useAppCatalogEvents(
  appId: string | undefined,
  enabled: boolean,
  onChange: () => void,
): void {
  useSseEvents(
    "/api/apps/events",
    {
      "catalog-change": {
        schema: catalogChangeSchema,
        fn: (event) => {
          if (event.appId === appId) onChange();
        },
      },
    },
    { enabled: Boolean(appId && enabled), onReconnect: onChange },
  );
}

/**
 * The sidebar's counterpart: it lists every app, so it wants every
 * `catalog-change` (an app the agent just built, an uninstall, a rename) plus
 * the reconnect catch-up, and answers each by invalidating the apps list.
 * `enabled` is the guardian check: a public-app visitor renders the shell too,
 * and the backend refuses them this stream.
 */
export function useAppCatalogChanges(enabled: boolean, onChange: () => void): void {
  useSseEvents(
    "/api/apps/events",
    {
      "catalog-change": {
        schema: catalogChangeSchema,
        fn: () => onChange(),
      },
    },
    { enabled, onReconnect: onChange },
  );
}
