import type { MiddlewareHandler } from "hono";
import { DashboardAccessState } from "../access/dashboard-access-state.js";
import { requireEntry } from "../access/require-entry.js";

/** The step every dashboard request passes, for a test that mounts routes on their own. */
export function entryStep(members: string[] = []): MiddlewareHandler {
  const allowList = new DashboardAccessState();
  allowList.setCloudEmailAccess(members);
  return requireEntry(allowList, () => false);
}
