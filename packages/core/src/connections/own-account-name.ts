import type { ConnectionRegistry } from "./registry.js";

/** The name a mention of Rome's account behind a connection shows, from its
 *  grant's profile: the field its kind names (`mentionedBy`), the handle by
 *  default, without a leading `@`. Null for a connection Rome does not know or
 *  a profile without that field. */
export function ownAccountNames(
  registry: Pick<ConnectionRegistry, "all" | "grantOf" | "getDescriptor">,
): (connectionId: string) => Promise<string | null> {
  return async (connectionId) => {
    const connection = registry.all().find((c) => c.id === connectionId);
    if (!connection) return null;
    const grant = await registry.grantOf(connection.id);
    const descriptor = registry.getDescriptor(connection.connectionKind);
    const revive = descriptor?.reviveProfile;
    if (!grant?.profile || !revive) return null;
    try {
      const profile = revive(grant.profile);
      const name = descriptor.mentionedBy === "displayName" ? profile.displayName : profile.handle;
      return name?.trim().replace(/^@/, "") || null;
    } catch {
      return null;
    }
  };
}
