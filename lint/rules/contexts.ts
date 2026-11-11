// Import rules between contexts, each a folder directly under
// packages/core/src. ALLOWED_IMPORTS names, for every context, the other
// contexts it may import. Every pair of contexts it does not name is a rule:
// the first context never imports the second, type-only imports included.
// Folders that are not listed here, such as db/, lib/ and the folders not yet
// in a context, are not checked.

import type { ImportRule, ListedCrossing } from "../import-rules.js";

const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  access: ["instance"],
  agent: ["instance"],
  "app-host": [
    "access",
    "agent",
    "apps",
    "chats",
    "connections",
    "favors",
    "instance",
    "people",
    "routines",
  ],
  apps: ["access", "instance"],
  chats: ["access", "agent", "apps", "connections", "participation", "people"],
  connections: ["apps", "chats", "desktops", "instance", "participation", "people"],
  desktops: ["access", "instance"],
  favors: ["access", "apps", "instance"],
  instance: [],
  participation: [],
  people: ["apps", "chats", "connections"],
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
  "favors-never-imports-agent":
    "A favor request runs an app action for a visitor, and no agent takes part in it, so no file in favors/ imports agent/.",
  "favors-never-imports-chats":
    "A favor request never names a chat or an account, so no file in favors/ imports chats/.",
  "favors-never-imports-connections":
    "A favor request never names a connection, so no file in favors/ imports connections/.",
  "favors-never-imports-people":
    "A favor request knows its visitor by their Rome Cloud account, not as a person, so no file in favors/ imports people/.",
  "desktops-never-imports-agent":
    "Desktops says which machines Rome can reach and what it can do on them, whoever asks, so no file in desktops/ imports agent/.",
  "desktops-never-imports-chats":
    "Desktops never names a chat or an account, so no file in desktops/ imports chats/.",
  "desktops-never-imports-connections":
    "A connection that needs a screen, such as WeChat's own-account connection, asks Desktops for one. Desktops never names a connection, so no file in desktops/ imports connections/.",
  "desktops-never-imports-people":
    "Desktops never names a person or an account, so no file in desktops/ imports people/.",
  "desktops-never-imports-apps":
    "Desktops answers whichever app asks and never knows which one it is, so no file in desktops/ imports apps/.",
  "desktops-never-imports-favors":
    "Desktops never knows what a favor asked for, so no file in desktops/ imports favors/.",
  "desktops-never-imports-participation":
    "Desktops never knows what woke an agent or where it speaks, so no file in desktops/ imports participation/.",
  "instance-never-imports-agent":
    "Instance says which Rome this is and whether it is healthy, whoever runs on it, so no file in instance/ imports agent/.",
  "instance-never-imports-apps":
    "Apps read the instance's identity and health, never the other way round, so no file in instance/ imports apps/.",
  "instance-never-imports-chats":
    "Instance never names a chat or an account, so no file in instance/ imports chats/.",
  "instance-never-imports-connections":
    "A connection asks Instance who this Rome is when it goes through Rome Cloud. Instance never names a connection, so no file in instance/ imports connections/.",
  "instance-never-imports-desktops":
    "Desktops asks Instance for this Rome's identity to reach a machine, never the other way round, so no file in instance/ imports desktops/.",
  "instance-never-imports-favors":
    "Favors asks Rome Cloud on the instance's behalf through Instance, never the other way round, so no file in instance/ imports favors/.",
  "instance-never-imports-participation":
    "Instance never decides when an agent takes part in a chat, so no file in instance/ imports participation/.",
  "instance-never-imports-people":
    "Instance never names a person, so no file in instance/ imports people/.",
  "instance-never-imports-access":
    "Access asks Instance which Rome Cloud this Rome belongs to, so no file in instance/ imports access/.",
};

function contextOf(path: string): string {
  return path.split("/")[0];
}

// Apps is what an app is and how it runs, and the contexts that use apps build
// on it. Handing an app what another context offers is App host's job.
const APPS_STAYS_FOUNDATIONAL =
  "Apps defines what an app receives and runs it, and App host fills that in from the other contexts, so no file in apps/ imports";

function describe(from: string, to: string, name: string): string {
  if (REASONS[name]) return REASONS[name];
  if (to === "app-host") {
    return `App host builds an app's ctx from every context, and only index.ts and the worker's entry point start it, so no file in ${from}/ imports app-host/.`;
  }
  if (from === "apps") return `${APPS_STAYS_FOUNDATIONAL} ${to}/.`;
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
const APP_FAVOR_CAPABILITY = ["apps/context.ts"];

/** One listed crossing for each `[from, to]` pair, all under one rule and ticket. */
function crossingsOf(
  rule: string,
  ticket: string,
  why: string,
  pairs: ReadonlyArray<readonly [string, string]>,
): ListedCrossing[] {
  return pairs.map(([from, to]) => ({ rule, from, to, ticket, why }));
}

/** Crossings that remain until their ticket lands. */
export const contextCrossings: ListedCrossing[] = [
  ...[
    [
      "connections-never-imports-app-host",
      "connections/kinds/email/email-delivery.test.ts",
      "app-host/service-proxies.ts",
    ],
    ["people-never-imports-app-host", "people/account-directory.test.ts", "app-host/chat-reads.ts"],
    [
      "routines-never-imports-app-host",
      "routines/routine-actor.test.ts",
      "app-host/caller-notify.ts",
    ],
  ].map(([rule, from, to]) => ({
    rule,
    from,
    to,
    ticket: "ZHA-167",
    why: "The test drives its scenario through App host code, until the scenario moves into an App host test.",
  })),
  ...crossingsOf(
    "people-never-imports-routines",
    "ZHA-166",
    "The guardian profile saves the guardian's timezone through Routines, until People no longer writes a setting Routines owns.",
    [
      ["people/guardian-profile.ts", "routines/guardian-timezone.ts"],
      ["people/guardian-profile.test.ts", "routines/guardian-timezone.ts"],
    ],
  ),
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
