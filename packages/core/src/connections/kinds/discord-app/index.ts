// Rome's own Discord bot, hosted by Rome Cloud. Nothing in Connections imports
// it, so leaving it out of the wiring leaves every other kind working.
// Vocabulary: docs/domains/connections.md.

import type { KindMount } from "../../kind-mount.js";
import { createDiscordAppDescriptor, type DiscordAppDescriptorDeps } from "./descriptor.js";
import { discordAppRoutes } from "./http/routes.js";

export { deliverDiscordFrame, isDiscordFrame } from "./drain.js";
export { romeCloudDiscordApp } from "./worker.js";
export type { DiscordAppDescriptorDeps } from "./descriptor.js";

export function discordApp(deps: DiscordAppDescriptorDeps): KindMount {
  return {
    descriptor: createDiscordAppDescriptor(deps),
    routes: discordAppRoutes({ cloud: deps.cloud, nameOf: deps.nameOf }),
  };
}
