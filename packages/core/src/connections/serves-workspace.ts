import type { ConnectionRegistry } from "./registry.js";

/** Whether the account behind a connection serves its whole workspace, as
 *  its kind declares (`servesWorkspace`). False for a connection Rome does
 *  not run. Read on each call, so a connection added later answers too. */
export function servesWorkspaceIn(
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor">,
): (connectionId: string) => boolean {
  return (connectionId) => {
    const connection = registry.all().find((c) => c.id === connectionId);
    if (!connection) return false;
    return registry.getDescriptor(connection.connectionKind)?.servesWorkspace === true;
  };
}
