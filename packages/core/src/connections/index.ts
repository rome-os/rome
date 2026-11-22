// Connection public surface. Vocabulary: docs/domains/connections.md.
// What Connections promises. "Not yet true": the code breaks it today, and nothing checks it.
// 1. It offers only what this file exports: connect, fix and disconnect with state changes, a
//    message arrived, send as the account, and each kind's tools. Not yet true.
// 2. Of apps/, it uses only the action contract, to offer each kind's tools. Not yet true.
// 3. `raw` has no shape outside the kind that made it, and a platform fact it exposes gets a
//    named field. Not yet true.
// 4. It delivers a chat's messages in order and at least once, and a repeat has the same id.
//    Order: @/test/kit/im/adapter-conformance.ts. At least once, same id: no check yet.
// 5. It reports what the platform said and decides nothing from it. Checked by review only.
export * from "./types.js";
export * from "./errors.js";
export * from "./schemes.js";
export * from "./grant.js";
export * from "./events.js";
export * from "./repository.js";
export { DrizzleConnectionsRepository } from "./repository-db.js";
export { ConnectionRegistry, type ConnectionRegistryDeps } from "./registry.js";
