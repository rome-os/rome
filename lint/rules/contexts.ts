// Import rules between contexts, each a folder directly under
// packages/core/src. A pair below names a direction the model forbids: the
// first context never imports the second, type-only imports included.

import type { ImportRule, ListedCrossing } from "../import-rules.js";

interface ForbiddenDependency {
  from: string;
  to: string;
  description: string;
}

const FORBIDDEN_DEPENDENCIES: ForbiddenDependency[] = [
  {
    from: "agent",
    to: "apps",
    description:
      "The agent context defines the extension points and Apps supplies them, so no file in agent/ imports apps/. An adapter that reads what an app ships lives in apps/ and implements the agent context's interface.",
  },
  {
    from: "agent",
    to: "connections",
    description:
      "An agent never knows which connection carries its chat, so no file in agent/ imports connections/. What an agent needs from a chat reaches it through Chats.",
  },
  {
    from: "apps",
    to: "favors",
    description:
      "A favor request exists to run an app action, so Favors depends on Apps and no file in apps/ imports favors/.",
  },
];

function contextOf(path: string): string {
  return path.split("/")[0];
}

export const contextRules: ImportRule[] = FORBIDDEN_DEPENDENCIES.map((dependency) => ({
  name: `${dependency.from}-never-imports-${dependency.to}`,
  description: dependency.description,
  rejects: (imp) =>
    imp.kind === "file" &&
    contextOf(imp.from) === dependency.from &&
    contextOf(imp.to) === dependency.to,
}));

const SESSIONS_REPOSITORY = "agent/infrastructure/drizzle-session-repository";

/** The apps/ files that give apps `ctx.favors` through Favors' `FavorService` type. */
const APP_FAVOR_CAPABILITY = [
  "apps/context.ts",
  "apps/context.test.ts",
  "apps/api.ts",
  "apps/websocket-server.ts",
  "apps/actions/app-actions-wiring.ts",
];

/** Crossings that remain until their ticket lands. */
export const contextCrossings: ListedCrossing[] = [
  ...APP_FAVOR_CAPABILITY.map((from) => ({
    rule: "apps-never-imports-favors",
    from,
    to: "favors/index.ts",
    ticket: "ZHA-163",
    why: "Apps offers `ctx.favors` by naming Favors' `FavorService` type, until Apps reaches favor requests without it.",
  })),
  {
    rule: "agent-never-imports-apps",
    from: `${SESSIONS_REPOSITORY}.ts`,
    to: "apps/artifact-id.ts",
    ticket: "ZHA-161",
    why: "The deprecated match of an agent under its legacy names, until agent names are canonical before they reach the sessions repository.",
  },
  {
    rule: "agent-never-imports-apps",
    from: `${SESSIONS_REPOSITORY}.test.ts`,
    to: "apps/artifact-id.ts",
    ticket: "ZHA-161",
    why: "The tests of that legacy-name match.",
  },
];
