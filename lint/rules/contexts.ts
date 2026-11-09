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
  ...["agent", "chats", "connections", "people", "routines"].map((to) => ({
    from: "access",
    to,
    description: `Access answers who may use this Rome, and as whom, for every other context, so no file in access/ imports ${to}/. A context that needs a sign-in decision imports access/.`,
  })),
  {
    from: "apps",
    to: "favors",
    description:
      "A favor request exists to run an app action, so Favors depends on Apps and no file in apps/ imports favors/.",
  },
  {
    from: "desktops",
    to: "agent",
    description:
      "Desktops says which machines Rome can reach and what it can do on them, whoever asks, so no file in desktops/ imports agent/.",
  },
  {
    from: "desktops",
    to: "chats",
    description:
      "Desktops never names a chat or an account, so no file in desktops/ imports chats/.",
  },
  {
    from: "desktops",
    to: "connections",
    description:
      "A connection that needs a screen, such as WeChat's own-account connection, asks Desktops for one. Desktops never names a connection, so no file in desktops/ imports connections/.",
  },
  {
    from: "desktops",
    to: "people",
    description:
      "Desktops never names a person or an account, so no file in desktops/ imports people/.",
  },
  {
    from: "instance",
    to: "agent",
    description:
      "Instance says which Rome this is and whether it is healthy, whoever runs on it, so no file in instance/ imports agent/.",
  },
  {
    from: "instance",
    to: "apps",
    description:
      "Apps read the instance's identity and health, never the other way round, so no file in instance/ imports apps/.",
  },
  {
    from: "instance",
    to: "chats",
    description:
      "Instance never names a chat or an account, so no file in instance/ imports chats/.",
  },
  {
    from: "instance",
    to: "connections",
    description:
      "A connection asks Instance who this Rome is when it goes through Rome Cloud. Instance never names a connection, so no file in instance/ imports connections/.",
  },
  {
    from: "instance",
    to: "desktops",
    description:
      "Desktops asks Instance for this Rome's identity to reach a machine, never the other way round, so no file in instance/ imports desktops/.",
  },
  {
    from: "instance",
    to: "favors",
    description:
      "Favors asks Rome Cloud on the instance's behalf through Instance, never the other way round, so no file in instance/ imports favors/.",
  },
  {
    from: "instance",
    to: "participation",
    description:
      "Instance never decides when an agent takes part in a chat, so no file in instance/ imports participation/.",
  },
  {
    from: "instance",
    to: "people",
    description: "Instance never names a person, so no file in instance/ imports people/.",
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
