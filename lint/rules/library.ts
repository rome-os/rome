// Library code, the files under packages/core/src/lib, serves every context
// and belongs to none. A lib/ file that imports a context is that context's
// code, so it moves into that context.

import type { ImportRule } from "../import-rules.js";
import { contexts } from "./contexts.js";

export const libraryRules: ImportRule[] = [
  {
    name: "lib-imports-no-context",
    description:
      "Library code belongs to no context, so no file in lib/ imports a context folder, type-only imports and tests included. A lib/ file that needs a context is that context's code and moves into it.",
    rejects: (imp) =>
      imp.kind === "file" && imp.from.startsWith("lib/") && contexts.includes(imp.to.split("/")[0]),
  },
];
