// Import rules for bounded contexts laid out as `<context>/<layer>` under
// packages/core/src. In a domain laid out as `<domain>/<feature>`
// (rules/features.ts), each feature and the domain root take the layers one
// level down: `<domain>/<feature>/<layer>` and `<domain>/<layer>`. The layout:
// DEVELOPMENT.md, "Established patterns".

import type { Import, ImportRule, ListedCrossing } from "../import-rules.js";
import { FEATURED_DOMAINS, isTest } from "./features.js";

/** Folders directly under src/ laid out as `<context>/<layer>`. A context adopting the layout joins this list. */
export const LAYERED_CONTEXTS = ["agent"];

type Layer = "domain" | "application" | "infrastructure" | "index" | "other";

/**
 * The context and layer of a src-relative path, or null for code outside every
 * layered context. A feature of a featured domain is a context of its own,
 * named `<domain>/<feature>`, and so is the domain root, named `<domain>`.
 */
function placeOf(path: string): { context: string; layer: Layer } | null {
  const parts = path.split("/");
  const features = FEATURED_DOMAINS[parts[0]];
  const depth = features?.includes(parts[1]) ? 2 : 1;
  if (!LAYERED_CONTEXTS.includes(parts[0]) && features === undefined) return null;
  const context = parts.slice(0, depth).join("/");
  const next = parts[depth];
  if (next === undefined) return null;
  if (next === "domain" || next === "application" || next === "infrastructure")
    return { context, layer: next };
  return { context, layer: /^index\.tsx?$/.test(next) ? "index" : "other" };
}

/** Whether a context has an index.ts as its public module: a layered context or a feature, but not a featured domain's root. */
function hasIndex(context: string): boolean {
  return LAYERED_CONTEXTS.includes(context) || context.includes("/");
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
      "A context's index.ts is its public module. Code outside a context imports nothing of it but index.ts. A featured domain's root has no index.ts; rules/features.ts judges its features.",
    rejects: (imp) => {
      if (imp.kind !== "file") return false;
      const to = placeOf(imp.to);
      if (to === null || to.layer === "index" || !hasIndex(to.context)) return false;
      return placeOf(imp.from)?.context !== to.context;
    },
  },
  {
    name: "literal-imports-in-contexts",
    description:
      "The layer rules can only judge an import they can resolve. A dynamic import inside a layered context names its module with a string literal.",
    rejects: (imp) => imp.kind === "computed" && placeOf(imp.from) !== null,
  },
  {
    name: "drizzle-stays-in-infrastructure",
    description:
      "Only a repository talks to the database. In a layered context or a featured domain, a file outside an infrastructure/ folder never imports drizzle-orm. Tests may, to seed and read tables.",
    rejects: (imp) =>
      imp.kind === "package" &&
      (imp.specifier === "drizzle-orm" || imp.specifier.startsWith("drizzle-orm/")) &&
      placeOf(imp.from) !== null &&
      !imp.from.split("/").includes("infrastructure") &&
      !isTest(imp.from),
  },
];

/**
 * Crossings a layered context or featured domain still makes on its way in.
 * Each leaves the list when the port that replaces it lands.
 */
export const listedCrossings: ListedCrossing[] = [
  {
    rule: "drizzle-stays-in-infrastructure",
    from: "people/guardian-profile/guardian-profile.ts",
    to: "drizzle-orm",
    ticket: "ZHA-212",
    why: "The guardian profile renames and creates the guardian's person with its own queries, until it goes through the People repository.",
  },
];
