// What the capability check knows about one app, read from its source. The
// rules judge these facts and never touch the filesystem.

/** What an action's input schema says about its arguments. */
export type ArgumentDescriptions =
  /** Every argument carries a description. */
  | { kind: "described" }
  /** These arguments carry none. */
  | { kind: "undescribed"; names: string[] }
  /** The schema is built in a way the reader cannot follow. */
  | { kind: "unknown" };

export interface ActionFacts {
  /** The name the action's `action.yaml` declares. */
  name: string;
  /** Where the action lives, relative to the app directory. */
  at: string;
  description: string;
  visibility: "public" | "explicit";
  sideEffects: "read-only" | "write";
  /** A webhook action is run by an external service, never by a person or an agent. */
  webhook: boolean;
  /** Whether the action hands Rome an input schema, which puts it in agent catalogs. */
  hasInputSchema: boolean;
  arguments: ArgumentDescriptions;
}

/** One route of the app API, the interface the app's page calls. */
export interface RouteFacts {
  /** `GET`, `POST`, … or several joined by `|`. */
  method: string;
  /** The path the route matches, without the app API prefix. `""` is the root. */
  path: string;
  /** `file:line`, relative to the app directory. */
  at: string;
  /** The actions the route runs through `runAction` or `invokeAction`, by the name it passes. */
  runs: string[];
  /** Calls through which the route writes app data itself, not through an action. */
  writes: string[];
  /** Why the reader could not tell which path the route matches, when it could not. */
  unreadable?: string;
  /** The route is declared `api.noAuth`: a machine endpoint, such as a webhook. */
  noAuth: boolean;
  /** The route is unreadable and the app declares `api.noAuth` paths, so it may be one. */
  mayBeNoAuth: boolean;
}

/** One import between two source files of the app, both relative to its source root. */
export interface ImportFacts {
  from: string;
  to: string;
  line: number;
}

/** A request the app's page makes without going through its app API. */
export interface PageRequestFacts {
  /** `file:line`, relative to the app directory. */
  at: string;
  /** The call, such as `fetch`. */
  call: string;
  /** The source text of what it requests. */
  target: string;
}

export interface AppFacts {
  id: string;
  /** The app directory, as given to the check. */
  dir: string;
  description: string;
  /** The app ships a page in the dashboard. */
  hasPage: boolean;
  /** The source root the folders below are relative to, relative to `dir`. */
  sourceRoot: string;
  actions: ActionFacts[];
  /**
   * Routes of the app API. `null` when the app declares an API whose routes
   * the reader could not find, so no route can be judged.
   */
  routes: RouteFacts[] | null;
  /** Where the app API's entry file is, when the app declares one. */
  apiEntry?: string;
  imports: ImportFacts[];
  pageRequests: PageRequestFacts[];
}
