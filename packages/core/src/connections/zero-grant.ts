import type { ConnectionRegistry } from "./registry.js";

/** Connection kinds whose Talk capability needs no grant (zero-grant unlock at
 *  birth): a connection must simply EXIST for the bridge to register
 *  its adapter. `ensureZeroGrantConnections` mints one per connection kind at boot if
 *  absent. WebChat is the only one. */
export const ZERO_GRANT_KINDS: readonly string[] = ["webchat"];

/**
 * Make sure a connection exists for every zero-grant connection kind. These
 * unlock at birth (no credential to import), so all boot needs to do is mint the
 * connection once — the registry builds the Talk epoch immediately and the
 * bridge registers its adapter on the synchronous first unlock. Idempotent:
 * skips a connection kind that already has a connection (rehydrated by `registry.load()`).
 */
export async function ensureZeroGrantConnections(registry: ConnectionRegistry): Promise<void> {
  for (const connectionKind of ZERO_GRANT_KINDS) {
    // Skip connection kinds this registry does not declare (e.g. a test registering only
    // a subset of descriptors); connect() would otherwise throw "no registered
    // descriptor".
    if (!registry.isRegistered(connectionKind)) continue;
    if (registry.find(connectionKind).length === 0) {
      await registry.connect(connectionKind);
    }
  }
}
