// Import rules for bounded contexts laid out as `<context>/<layer>` under
// packages/core/src. The layout: DEVELOPMENT.md, "Established patterns".

import type { Import, ImportRule, ListedCrossing } from "../import-rules.js";

/** Folders directly under src/ laid out as `<context>/<layer>`. A context adopting the layout joins this list. */
export const LAYERED_CONTEXTS = ["agent"];

type Layer = "domain" | "application" | "infrastructure" | "index" | "other";

/** The context and layer of a src-relative path, or null for code outside every layered context. */
function placeOf(path: string): { context: string; layer: Layer } | null {
  const [context, next] = path.split("/");
  if (!LAYERED_CONTEXTS.includes(context) || next === undefined) return null;
  if (next === "domain" || next === "application" || next === "infrastructure")
    return { context, layer: next };
  return { context, layer: /^index\.tsx?$/.test(next) ? "index" : "other" };
}

/** For a file import from `layer`: is the target in the importer's context and one of `allowed`? */
function staysWithin(imp: Import, layer: Layer, allowed: Layer[]): boolean | null {
  if (imp.kind !== "file") return null;
  const from = placeOf(imp.from);
  if (from?.layer !== layer) return null;
  const to = placeOf(imp.to);
  return to !== null && to.context === from.context && allowed.includes(to.layer);
}

export const layerRules: ImportRule[] = [
  {
    name: "domain-imports-domain",
    description:
      "The domain depends on nothing outward. A file in domain/ imports only its own context's domain/ and packages.",
    rejects: (imp) => staysWithin(imp, "domain", ["domain"]) === false,
  },
  {
    name: "application-imports-inward",
    description:
      "Use cases depend only on the model. A file in application/ imports only its own context's domain/, application/ and packages.",
    rejects: (imp) => staysWithin(imp, "application", ["domain", "application"]) === false,
  },
  {
    name: "infrastructure-imports-inward",
    description:
      "Adapters depend inward, never on what wires them. A file in infrastructure/ never imports its own context's application/ or index.ts.",
    rejects: (imp) => staysWithin(imp, "infrastructure", ["application", "index"]) === true,
  },
  {
    name: "enter-through-index",
    description:
      "A context's index.ts is its public module. Code outside a context imports nothing of it but index.ts.",
    rejects: (imp) => {
      if (imp.kind !== "file") return false;
      const to = placeOf(imp.to);
      if (to === null || to.layer === "index") return false;
      return placeOf(imp.from)?.context !== to.context;
    },
  },
  {
    name: "literal-imports-in-contexts",
    description:
      "The layer rules can only judge an import they can resolve. A dynamic import inside a layered context names its module with a string literal.",
    rejects: (imp) => imp.kind === "computed" && placeOf(imp.from) !== null,
  },
];

/**
 * Crossings the agent context still makes on its way in. Each leaves the list
 * when the port that replaces it lands.
 */
export const listedCrossings: ListedCrossing[] = [];
