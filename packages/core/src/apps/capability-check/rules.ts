// The rules for two goals. Agents can discover what an app can do, and every
// app capability has an interface for agents and one for people.
//
// The model the rules hold an app to: a capability is an action. The action
// is the domain core. Agents reach it through the agent catalog (an input
// schema and public visibility). People reach it through the app's page,
// which calls the app API, which runs the action with `runAction`. Both
// interfaces adapt the same action, and neither re-implements it.

import type { ActionFacts, AppFacts, ImportFacts, RouteFacts } from "./facts.js";

export type Goal = "discover" | "interfaces";

export interface Rule {
  id: string;
  goal: Goal;
  /** The rule, stated so a person can apply it to a diff. */
  statement: string;
}

export const RULES = [
  {
    id: "D1",
    goal: "discover",
    statement:
      "Every app says what it is for in `app.yaml#description`, in at least 40 characters. Every agent reads it under Installed Apps.",
  },
  {
    id: "D2",
    goal: "discover",
    statement:
      "Every public action declares an input schema, so it appears in agent catalogs. An action only routines or hooks run declares `visibility: explicit`.",
  },
  {
    id: "D3",
    goal: "discover",
    statement: "Every argument of an agent-callable action has a description.",
  },
  {
    id: "I1",
    goal: "interfaces",
    statement:
      "Every app API route a person's page calls runs an agent-callable action, so an agent can do what a person can. Machine routes (`api.noAuth`) and the status routes (the root, and `GET /status`) are exempt. A route whose path the check cannot read is left for a person to judge, never passed.",
  },
  {
    id: "I2",
    goal: "interfaces",
    statement:
      "Every agent-callable action is run by an app API route that the app's page calls, so a person can do from the page what an agent can. Webhook actions are exempt.",
  },
  {
    id: "I3",
    goal: "interfaces",
    statement:
      "An app API route never writes app data itself. Every write goes through an action, so the agent and the page change data the same way.",
  },
  {
    id: "I4",
    goal: "interfaces",
    statement:
      "Both interfaces share the actions as one core, and lower code never knows upper code. Actions, data and shared code never import the API or the page, and data and shared code never import actions. The page never imports actions, data or the API. The API reaches an action only through `runAction`, never by importing it.",
  },
  {
    id: "I5",
    goal: "interfaces",
    statement:
      "The page reaches Rome and the world only through its app API and the web SDK, never with its own `fetch`, so nothing a person does from it skips the actions.",
  },
] as const satisfies readonly Rule[];

export type RuleId = (typeof RULES)[number]["id"];

/** One place where an app falls short of a rule. */
export interface Gap {
  rule: RuleId;
  appId: string;
  /** Where the gap is, relative to the app directory. */
  at: string;
  message: string;
}

/** Something the check could not judge, so a person has to. */
export interface Unverified {
  /** The rule the check could not judge. */
  rule: RuleId;
  appId: string;
  at: string;
  message: string;
}

export interface AppVerdict {
  appId: string;
  gaps: Gap[];
  unverified: Unverified[];
}

const MIN_DESCRIPTION_LENGTH = 40;

export function isAgentCallable(action: ActionFacts): boolean {
  return action.hasInputSchema && action.visibility === "public";
}

/** Applies every rule to one app. */
export function checkApp(app: AppFacts): AppVerdict {
  const gaps: Gap[] = [];
  const unverified: Unverified[] = [];
  const gap = (rule: RuleId, at: string, message: string) =>
    gaps.push({ rule, appId: app.id, at, message });
  const cannotJudge = (rule: RuleId, at: string, message: string) =>
    unverified.push({ rule, appId: app.id, at, message });

  // D1
  if (app.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    gap(
      "D1",
      "app.yaml",
      `The description has ${app.description.trim().length} characters, too few to tell an agent what the app can do.`,
    );
  }

  for (const action of app.actions) {
    // D2
    if (action.visibility === "public" && !action.hasInputSchema && !action.webhook) {
      gap(
        "D2",
        action.at,
        `\`${action.name}\` is public but has no input schema, so no agent can find it.`,
      );
    }
    if (action.schemaUntied && action.visibility === "public" && !action.webhook) {
      cannotJudge(
        "D2",
        action.at,
        `Found an input schema near \`${action.name}\` but could not tie it to the action the module returns.`,
      );
    }
    // D3
    if (isAgentCallable(action)) {
      if (action.arguments.kind === "undescribed") {
        gap(
          "D3",
          action.at,
          `\`${action.name}\` leaves ${action.arguments.names.map((n) => `\`${n}\``).join(", ")} undescribed.`,
        );
      } else if (action.arguments.kind === "unknown") {
        cannotJudge("D3", action.at, `Could not read the input schema of \`${action.name}\`.`);
      }
    }
  }

  // I1 and I2
  if (app.routes === null) {
    // Routes the reader cannot find are not proof of a gap.
    if (!app.wholeApiNoAuth) {
      cannotJudge(
        "I1",
        app.apiEntry ?? "app.yaml",
        "The app declares an API, but the reader found no routes in its entry.",
      );
    }
    for (const action of app.actions) {
      if (!isAgentCallable(action) || action.webhook) continue;
      cannotJudge(
        "I2",
        action.at,
        `Could not read the routes, so whether a page runs \`${action.name}\` was not judged.`,
      );
    }
  } else {
    for (const route of app.routes) judgeRoute(app, route, gap, cannotJudge);
    for (const action of app.actions) {
      if (!isAgentCallable(action) || action.webhook) continue;
      judgeHumanInterface(app, action, gap, cannotJudge);
    }
  }

  // I4
  for (const imp of app.imports) {
    const reason = layerViolation(imp);
    if (reason) gap("I4", `${app.sourceRoot}/${imp.from}:${imp.line}`, reason);
  }
  // Shared code may import data, but not when the page is built from it.
  for (const imp of app.pageCrossings) {
    if (layerViolation(imp)) continue;
    gap(
      "I4",
      `${app.sourceRoot}/${imp.from}:${imp.line}`,
      `\`${imp.from}\` is part of the page and imports \`${imp.to}\`, so the page reaches past its app API.`,
    );
  }

  // I5
  for (const request of app.pageRequests) {
    gap(
      "I5",
      request.at,
      `The page calls \`${request.call}(${request.target})\` past its app API, so no action stands behind what it does.`,
    );
  }

  return { appId: app.id, gaps, unverified };
}

/**
 * I2: a person can run `action` only from a page that calls a route that
 * runs it. Machine routes reach no person.
 */
function judgeHumanInterface(
  app: AppFacts,
  action: ActionFacts,
  gap: (rule: RuleId, at: string, message: string) => void,
  cannotJudge: (rule: RuleId, at: string, message: string) => void,
): void {
  if (!app.hasPage) {
    gap("I2", action.at, `\`${action.name}\` has no human interface: the app has no page.`);
    return;
  }
  const running = (app.routes ?? []).filter(
    (route) => !route.noAuth && route.runs.some((name) => localName(app.id, name) === action.name),
  );
  if (running.length === 0) {
    // A route that runs an action whose name it computes may run this one.
    if (app.routes?.some((route) => !route.noAuth && route.runs.includes("<dynamic>"))) {
      cannotJudge(
        "I2",
        action.at,
        `No route names \`${action.name}\`, but a route runs an action whose name is computed.`,
      );
      return;
    }
    // A dispatcher the reader cannot split may run it where the reader does not look.
    if (app.routes?.some((route) => !route.noAuth && route.dispatches)) {
      cannotJudge(
        "I2",
        action.at,
        `No route the reader can follow runs \`${action.name}\`, but a route hands requests to a dispatcher it cannot split.`,
      );
      return;
    }
    gap(
      "I2",
      action.at,
      `No app API route runs \`${action.name}\`, so a person cannot do it from the app's page.`,
    );
    return;
  }
  // Only a route the reader placed proves that the page reaches the action.
  const called = running.some(
    (route) =>
      !route.unreadable &&
      app.pageApiCalls.some(
        (call) =>
          call.path !== null &&
          call.method !== null &&
          pathMatches(route, call.path) &&
          methodMatches(route, call.method),
      ),
  );
  if (called) return;
  // A call whose method the reader cannot tell may be the one that reaches the route.
  const unknownMethod = running.some((route) =>
    app.pageApiCalls.some(
      (call) => call.path !== null && call.method === null && pathMatches(route, call.path),
    ),
  );
  if (
    unknownMethod ||
    running.some((route) => route.unreadable) ||
    app.pageApiCalls.some((c) => c.path === null)
  ) {
    cannotJudge(
      "I2",
      action.at,
      `Could not tell whether the page calls the route that runs \`${action.name}\`.`,
    );
    return;
  }
  gap(
    "I2",
    action.at,
    `The page never calls \`/${running[0]?.path}\`, the route that runs \`${action.name}\`, so a person cannot do it from the page.`,
  );
}

/** The root route, or `GET /status`, which only report that the app is up. */
function isStatusRoute(path: string, method: string): boolean {
  if (path === "") return method === "GET" || method === "ANY";
  return path === "status" && method === "GET";
}

/** Whether a call with `method` reaches `route`, which may take several. */
function methodMatches(route: RouteFacts, method: string): boolean {
  if (route.method === "ANY") return true;
  return route.method.split("|").includes(method);
}

/**
 * Whether a page's call to `called` reaches `route`. `:id` matches any one
 * segment, `*` one or more, and `**` any number.
 */
function pathMatches(route: RouteFacts, called: string): boolean {
  const callSegments = called === "" ? [] : called.split("/");
  return (route.alternatives ?? [route.path]).some((path) => {
    const routeSegments = path === "" ? [] : path.split("/");
    for (let i = 0; i < routeSegments.length; i++) {
      const segment = routeSegments[i] as string;
      if (segment === "*") return callSegments.length > i;
      if (segment === "**") return callSegments.length >= i;
      const call = callSegments[i];
      if (call === undefined) return false;
      if (segment !== ":id" && call !== ":id" && segment !== call) return false;
    }
    return route.openEnded
      ? callSegments.length >= routeSegments.length
      : callSegments.length === routeSegments.length;
  });
}

function judgeRoute(
  app: AppFacts,
  route: RouteFacts,
  gap: (rule: RuleId, at: string, message: string) => void,
  cannotJudge: (rule: RuleId, at: string, message: string) => void,
): void {
  if (route.noAuth) return;
  const label = `\`${route.method} /${route.path}\``;
  if (route.unreadable) {
    cannotJudge(
      "I1",
      route.at,
      `Could not place this route (${route.unreadable}), so whether an action stands behind it was not judged.`,
    );
  }
  // An unreadable route may be a machine route, which I3 spares, when the app declares any.
  if (route.writes.length > 0 && !route.mayBeNoAuth) {
    gap(
      "I3",
      route.at,
      `${route.unreadable ? "Code the reader cannot place on a route" : label} writes app data itself (${route.writes.map((w) => `\`${w}\``).join(", ")}), so an agent cannot make the same change.`,
    );
  } else if (route.writes.length > 0) {
    cannotJudge(
      "I3",
      route.at,
      "Code the reader cannot place on a route writes app data itself, and may serve a machine route.",
    );
  }
  if (route.unreadable) return;
  if (isStatusRoute(route.path, route.method) && route.openEnded) {
    // `path[0] === "status"` also serves `/status/history`, which the exemption does not cover.
    cannotJudge(
      "I1",
      route.at,
      `${label} also serves the paths below it, which the status exemption does not cover.`,
    );
    return;
  }
  if (isStatusRoute(route.path, route.method)) {
    // A status route is exempt, but not the other paths it may also serve.
    const others = (route.alternatives ?? []).filter((path) => !isStatusRoute(path, route.method));
    if (others.length > 0 && route.runs.length === 0) {
      cannotJudge(
        "I1",
        route.at,
        `${label} also serves ${others.map((p) => `\`/${p}\``).join(", ")}, which the status exemption does not cover.`,
      );
    }
    return;
  }
  if (route.runs.length === 0) {
    gap("I1", route.at, `${label} runs no action, so no agent can do what it does.`);
    return;
  }
  for (const name of route.runs) {
    if (name === "<dynamic>") {
      cannotJudge("I1", route.at, `${label} runs an action whose name is computed.`);
      continue;
    }
    const own = app.actions.find((action) => action.name === localName(app.id, name));
    if (!own) {
      cannotJudge("I1", route.at, `${label} runs \`${name}\`, which another app owns.`);
      continue;
    }
    if (own.schemaUntied) {
      cannotJudge(
        "I1",
        route.at,
        `${label} runs \`${own.name}\`, whose input schema could not be tied to it.`,
      );
      continue;
    }
    if (!isAgentCallable(own)) {
      gap(
        "I1",
        route.at,
        `${label} runs \`${own.name}\`, which is ${own.hasInputSchema ? "explicit" : "missing an input schema"}, so agents cannot find it.`,
      );
    }
  }
}

/** `notes:add_note` and `add_note` both name `add_note` in app `notes`. */
function localName(appId: string, name: string): string {
  const prefix = `${appId}:`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

type Layer = "actions" | "api" | "web" | "data" | "shared" | "outside";

function layerOf(path: string): Layer {
  if (path.startsWith("../")) return "outside";
  const top = path.split("/")[0];
  if (top === "actions" || top === "api" || top === "web") return top;
  if (top === "db") return "data";
  return "shared";
}

/** Why `imp` crosses a layer it may not, or undefined. */
export function layerViolation(imp: ImportFacts): string | undefined {
  const from = layerOf(imp.from);
  const to = layerOf(imp.to);
  if (from === to || from === "outside" || to === "outside") return undefined;
  const crossing = `\`${imp.from}\` imports \`${imp.to}\``;
  if ((to === "api" || to === "web") && from !== "web" && from !== "api") {
    return `${crossing}: core code must not know about an interface.`;
  }
  if ((from === "data" || from === "shared") && to === "actions") {
    return `${crossing}: lower code must not know about the actions built on it.`;
  }
  if (from === "web" && to !== "shared") {
    return `${crossing}: the page reaches the app only through the app API.`;
  }
  if (from === "api" && to === "web") {
    return `${crossing}: the API must not know about the page.`;
  }
  if (from === "api" && to === "actions") {
    return `${crossing}: the API runs an action through \`runAction\`, so approval, attribution and visibility apply.`;
  }
  return undefined;
}
