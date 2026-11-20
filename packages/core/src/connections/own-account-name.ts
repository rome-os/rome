import type { ConnectionRegistry } from "./registry.js";

/** The name of Rome's account behind a connection, as its grant's profile
 *  shows it: the handle a mention of it carries, else its display name. Null
 *  for a connection Rome does not know or a profile that names nothing. */
export function ownAccountNames(
  registry: Pick<ConnectionRegistry, "all" | "grantOf" | "getDescriptor">,
): (connectionId: string) => Promise<string | null> {
  return async (connectionId) => {
    const connection = registry.all().find((c) => c.id === connectionId);
    if (!connection) return null;
    const grant = await registry.grantOf(connection.id);
    const revive = registry.getDescriptor(connection.connectionKind)?.reviveProfile;
    if (!grant?.profile || !revive) return null;
    try {
      const profile = revive(grant.profile);
      return profile.handle?.trim() || profile.displayName?.trim() || null;
    } catch {
      return null;
    }
  };
}
