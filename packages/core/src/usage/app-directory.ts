import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactOwnership } from "../apps/types.js";
import type { AgentCatalog } from "../agent/index.js";
import type { UsageAppDirectory } from "./attribution.js";

/**
 * Reports a store app by its App Store listing id and a first-party app as
 * `first-party:<appId>`. Any other app is `local`, so the name of an app the
 * guardian built or installed by hand never leaves the instance.
 */
export function createUsageAppDirectory(deps: {
  agentLoader: Pick<AgentCatalog, "find">;
  actionRegistry: { getMetadata(actionName: string): ArtifactOwnership | undefined };
  appCatalog: Pick<AppCatalog, "get">;
}): UsageAppDirectory {
  const forApp = (appId: string): string | null => {
    const app = deps.appCatalog.get(appId);
    if (!app) return null;
    if (app.source.mode === "appstore") return app.source.listingId;
    return app.firstParty ? `first-party:${app.appId}` : "local";
  };
  const forOwner = (owner: ArtifactOwnership | undefined): string | null =>
    owner?.ownerType === "app" ? forApp(owner.ownerId) : null;
  return {
    forApp,
    forAction: (actionName) => forOwner(deps.actionRegistry.getMetadata(actionName)),
    // An agent unloaded after its turn ran reports no app.
    forAgent: (agentName) => forOwner(deps.agentLoader.find(agentName)),
  };
}
