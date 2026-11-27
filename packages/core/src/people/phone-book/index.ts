// The phone book: the people listing and the directory of accounts. It serves
// the dashboard through http/, and agents through nothing. Nothing but the wiring
// imports it, so leaving it out leaves who-is-this and the message path
// working. Vocabulary: docs/domains/people.md.

import type { Action } from "@rome-os/app-runtime";
import type { PhoneBookDeps } from "./deps.js";
import { phoneBookRoutes } from "./http/index.js";

export type { PhoneBookDeps } from "./deps.js";
export { readAccountDirectory } from "./application/account-directory.js";
/** The routes alone, for a test that mounts them beside another feature's. */
export { phoneBookRoutes } from "./http/index.js";

/** The phone book's two interfaces. Leaving the phone book out is not building this. */
export interface PhoneBook {
  /** Routes for the dashboard and apps, mounted under /api. */
  routes: ReturnType<typeof phoneBookRoutes>;
  /** Actions for agents: none. */
  actions: Action[];
}

export function phoneBook(deps: PhoneBookDeps): PhoneBook {
  return { routes: phoneBookRoutes(deps), actions: [] };
}
