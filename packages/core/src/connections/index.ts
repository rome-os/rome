// Connection public surface. Vocabulary: docs/domains/connections.md.
// Promises, and what checks each one: ./AGENTS.md.

export * from "./types.js";
export * from "./errors.js";
export * from "./schemes.js";
export * from "./grant.js";
export * from "./events.js";
export * from "./repository.js";
export { DrizzleConnectionsRepository } from "./repository-db.js";
export { ConnectionRegistry, type ConnectionRegistryDeps } from "./registry.js";
export type { ConnectParticipant } from "./setup/types.js";
export type { Command, CommandOptionSpec, CommandSpec, Commands } from "./command.js";
