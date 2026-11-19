// The link code: the guardian proves an account on a connection is theirs by
// sending Rome a short code. The dashboard asks for one through http/; the
// rules are in application/. Vocabulary: docs/domains/people.md.

import type { Action } from "@rome-os/app-runtime";
import type { LinkCodeDeps } from "./deps.js";
import { linkCodeRoutes } from "./http/index.js";

export {
  createGuardianLinkAdmission,
  GuardianLinkCodes,
  isLinkCodeMessage,
} from "./application/guardian-link-code.js";

export type { LinkCodeDeps } from "./deps.js";

/** The link code's two interfaces. Leaving it out is not building this. */
export interface LinkCode {
  /** Routes for the dashboard, mounted under /api. */
  routes: ReturnType<typeof linkCodeRoutes>;
  /** Actions for agents. None: a code proves an account is the guardian's,
   *  so only the guardian asks for one. */
  actions: Action[];
}

export function linkCode(deps: LinkCodeDeps): LinkCode {
  return { routes: linkCodeRoutes(deps), actions: [] };
}
