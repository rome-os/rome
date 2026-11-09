// Import rules between contexts, each a folder directly under
// packages/core/src. ALLOWED_IMPORTS names, for every context, the other
// contexts it may import. Every pair of contexts it does not name is a rule:
// the first context never imports the second, type-only imports included.
// Folders that are not listed here, such as db/, lib/ and the folders not yet
// in a context, are not checked.

import type { ImportRule, ListedCrossing } from "../import-rules.js";

const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  access: ["apps", "instance"],
  agent: ["instance", "routines"],
  apps: ["access", "agent", "chats", "connections", "instance", "people", "routines"],
  chats: ["access", "agent", "apps", "connections", "people"],
  connections: ["apps", "chats", "desktops", "instance", "people"],
  desktops: ["access", "instance"],
  favors: ["access", "apps", "instance"],
  instance: ["apps"],
  people: ["apps", "chats", "connections", "routines"],
  routines: ["access", "agent", "apps"],
};

/** Why a context never imports another, where the model says more than the graph. */
const REASONS: Record<string, string> = {
  "agent-never-imports-apps":
    "The agent context defines the extension points and Apps supplies them, so no file in agent/ imports apps/. An adapter that reads what an app ships lives in apps/ and implements the agent context's interface.",
  "agent-never-imports-connections":
    "An agent never knows which connection carries its chat, so no file in agent/ imports connections/. What an agent needs from a chat reaches it through Chats.",
  "apps-never-imports-favors":
    "A favor request exists to run an app action, so Favors depends on Apps and no file in apps/ imports favors/.",
  "desktops-never-imports-agent":
    "Desktops says which machines Rome can reach and what it can do on them, whoever asks, so no file in desktops/ imports agent/.",
  "desktops-never-imports-chats":
    "Desktops never names a chat or an account, so no file in desktops/ imports chats/.",
  "desktops-never-imports-connections":
    "A connection that needs a screen, such as WeChat's own-account connection, asks Desktops for one. Desktops never names a connection, so no file in desktops/ imports connections/.",
  "desktops-never-imports-people":
    "Desktops never names a person or an account, so no file in desktops/ imports people/.",
  "instance-never-imports-access":
    "Access asks Instance which Rome Cloud this Rome belongs to, so no file in instance/ imports access/.",
};

function contextOf(path: string): string {
  return path.split("/")[0];
}

function describe(from: string, to: string, name: string): string {
  if (REASONS[name]) return REASONS[name];
  const allowed = ALLOWED_IMPORTS[from];
  const may = allowed.length > 0 ? allowed.map((c) => `${c}/`).join(", ") : "no other context";
  return `${from}/ may import only ${may}, so no file in ${from}/ imports ${to}/.`;
}

const contexts = Object.keys(ALLOWED_IMPORTS);

export const contextRules: ImportRule[] = contexts.flatMap((from) =>
  contexts
    .filter((to) => to !== from && !ALLOWED_IMPORTS[from].includes(to))
    .map((to) => {
      const name = `${from}-never-imports-${to}`;
      return {
        name,
        description: describe(from, to, name),
        rejects: (imp) =>
          imp.kind === "file" && contextOf(imp.from) === from && contextOf(imp.to) === to,
      } satisfies ImportRule;
    }),
);

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
