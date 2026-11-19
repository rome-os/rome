// What a kind of connection hands the wiring. Each kind's index.ts under
// kinds/ builds one, and the wiring lists them. The layout: DEVELOPMENT.md,
// "Established patterns".

import type { Hono } from "hono";
import type { ConnectionDescriptor } from "./types.js";

/** One kind of connection, ready to mount. Leaving the kind out is not building this. */
export interface KindMount {
  /** Registered on the connection registry before it loads. Null when this
   *  Rome offers no connection of the kind, as when its config is off. */
  descriptor: ConnectionDescriptor | null;
  /** Routes for the dashboard and apps, mounted under /api. */
  routes?: Hono;
}
