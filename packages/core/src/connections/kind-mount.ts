// What a kind of connection hands the wiring. Each kind's index.ts under
// kinds/ builds one, and the wiring lists them. The layout: DEVELOPMENT.md,
// "Established patterns".

import type { ConnectionDescriptor } from "./types.js";

/** One kind of connection, ready to mount. Leaving the kind out is not building this. */
export interface KindMount {
  /** Registered on the connection registry before it loads. */
  descriptor: ConnectionDescriptor;
}
