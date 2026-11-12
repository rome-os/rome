// The wiring builds the object graph from every context and serves it, so no
// context imports it. The wiring is api/, wiring/, bin/, the root index.ts and
// chats-wiring.ts under packages/core/src. Type-only imports and tests count.

import type { Import, ImportRule, ListedCrossing } from "../import-rules.js";
import { contexts } from "./contexts.js";

const WIRING_FOLDERS = ["api", "wiring", "bin"];
const WIRING_FILES = ["index.ts", "chats-wiring.ts"];

function isWiring(path: string): boolean {
  return WIRING_FILES.includes(path) || WIRING_FOLDERS.includes(path.split("/")[0]);
}

export const wiringRules: ImportRule[] = [
  {
    name: "contexts-never-import-wiring",
    description:
      "The wiring builds every context and serves it over HTTP, so no file in a context imports api/, wiring/, bin/, index.ts or chats-wiring.ts. Code a context owns lives in the context, and a generic helper lives in lib/.",
    rejects: (imp: Import) =>
      imp.kind === "file" && contexts.includes(imp.from.split("/")[0]) && isWiring(imp.to),
  },
];

/** Crossings that remain until their ticket lands. */
export const wiringCrossings: ListedCrossing[] = [
  {
    rule: "contexts-never-import-wiring",
    from: "concierge/connectors.ts",
    to: "api/routes/connections.ts",
    ticket: "ZHA-173",
    why: "The Concierge's list of services starts from the GET /connections response, until it reads connection state from Connections.",
  },
  {
    rule: "contexts-never-import-wiring",
    from: "concierge/following.ts",
    to: "api/routes/connections.ts",
    ticket: "ZHA-173",
    why: "The Concierge's list of services starts from the GET /connections response, until it reads connection state from Connections.",
  },
  {
    rule: "contexts-never-import-wiring",
    from: "concierge/following.test.ts",
    to: "api/routes/connections.ts",
    ticket: "ZHA-173",
    why: "The Concierge's list of services starts from the GET /connections response, until it reads connection state from Connections.",
  },
  {
    rule: "contexts-never-import-wiring",
    from: "app-host/worker-runtime.ts",
    to: "chats-wiring.ts",
    ticket: "ZHA-172",
    why: "The app worker builds its own object graph in app-host/, until its entry point moves into wiring/.",
  },
  {
    rule: "contexts-never-import-wiring",
    from: "instance/diagnostics.ts",
    to: "api/deps.ts",
    ticket: "ZHA-169",
    why: "The diagnostics report reads apps and connections through ApiDeps, until it gets each context's status from that context.",
  },
];
