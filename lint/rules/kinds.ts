// Import rules for the kinds of connection under packages/core/src/connections/kinds/.
// Each kind is a mountable part: its index.ts exports the one entry the wiring
// lists, and leaving the kind out is deleting its line. A kind builds on the
// Connections root, and nothing else in Connections, not even another kind,
// depends on it. The layout: DEVELOPMENT.md, "Established patterns".
// Vocabulary: docs/domains/connections.md#connection-kind.

import type { Import, ImportRule, ListedCrossing } from "../import-rules.js";

/** Kinds of connection laid out as mountable parts. A kind joins this list in the PR that moves it to the layout. */
export const CONNECTION_KINDS: readonly string[] = [];

const KINDS_FOLDER = "connections/kinds/";

/**
 * The kind a src-relative path sits in, with the path's segments inside the
 * kind's folder, or null outside every listed kind.
 * kindOf("connections/kinds/discord/http/x.ts", ["discord"]) returns
 * { kind: "discord", rest: ["http", "x.ts"] }.
 */
export function kindOf(
  path: string,
  kinds: readonly string[],
): { kind: string; rest: string[] } | null {
  if (!path.startsWith(KINDS_FOLDER)) return null;
  const [kind, ...rest] = path.slice(KINDS_FOLDER.length).split("/");
  return kinds.includes(kind) && rest.length > 0 ? { kind, rest } : null;
}

function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

function isIndex(rest: string[]): boolean {
  return rest.length === 1 && /^index\.tsx?$/.test(rest[0]);
}

/** The rules over a given list of kinds. The lint runs them over CONNECTION_KINDS. */
export function kindRulesFor(kinds: readonly string[]): ImportRule[] {
  const into = (imp: Import) => (imp.kind === "file" ? kindOf(imp.to, kinds) : null);
  return [
    {
      name: "connections-root-names-no-kind",
      description:
        "Every kind builds on the Connections root, so a file in connections/ outside a listed kind imports none of it. The wiring, not the root, lists the kinds it mounts.",
      rejects: (imp) =>
        into(imp) !== null &&
        imp.from.startsWith("connections/") &&
        kindOf(imp.from, kinds) === null &&
        !isTest(imp.from),
    },
    {
      name: "kinds-import-no-sibling",
      description:
        "Each kind can be left out on its own, so a file in one kind of connection imports no other kind.",
      rejects: (imp) => {
        const to = into(imp);
        const from = kindOf(imp.from, kinds);
        return to !== null && from !== null && from.kind !== to.kind;
      },
    },
    {
      name: "kinds-enter-through-index",
      description:
        "A kind's index.ts is the one entry the wiring mounts, so code outside a kind imports nothing of it but index.ts. Tests may reach further.",
      rejects: (imp) => {
        const to = into(imp);
        if (to === null || isIndex(to.rest) || isTest(imp.from)) return false;
        return kindOf(imp.from, kinds)?.kind !== to.kind;
      },
    },
    {
      name: "kind-adapters-import-inward",
      description:
        "A kind's use cases in application/ serve apps through http/ and agents through actions/, so application/ imports neither adapter, and neither adapter imports the other.",
      rejects: (imp) => {
        const to = into(imp);
        const from = kindOf(imp.from, kinds);
        if (to === null || from === null || from.kind !== to.kind) return false;
        const sides = ["application", "http", "actions"];
        if (!sides.includes(from.rest[0]) || (to.rest[0] !== "http" && to.rest[0] !== "actions"))
          return false;
        return from.rest[0] !== to.rest[0];
      },
    },
    {
      name: "kind-hono-stays-in-http",
      description:
        "A kind serves apps through http/ and agents through actions/, so in a kind of connection only a file in its http/ folder imports hono. Tests may, to mount routes.",
      rejects: (imp) =>
        imp.kind === "package" &&
        (imp.specifier === "hono" || imp.specifier.startsWith("hono/")) &&
        kindOf(imp.from, kinds) !== null &&
        kindOf(imp.from, kinds)?.rest[0] !== "http" &&
        !isTest(imp.from),
    },
    {
      name: "kind-drizzle-stays-in-infrastructure",
      description:
        "Only a repository talks to the database, so in a kind of connection only a file in its infrastructure/ folder imports drizzle-orm. Tests may, to seed and read tables.",
      rejects: (imp) =>
        imp.kind === "package" &&
        (imp.specifier === "drizzle-orm" || imp.specifier.startsWith("drizzle-orm/")) &&
        kindOf(imp.from, kinds) !== null &&
        kindOf(imp.from, kinds)?.rest[0] !== "infrastructure" &&
        !isTest(imp.from),
    },
  ];
}

export const kindRules = kindRulesFor(CONNECTION_KINDS);

/** Crossings that remain until their ticket lands. */
export const kindCrossings: ListedCrossing[] = [];
