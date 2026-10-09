import type { AppCatalog } from "../apps/catalog.js";
import { isResolvedApp, type CatalogEvent, type ResolvedApp } from "../apps/state.js";
import type { Action } from "../actions/types.js";
import type { ArtifactMetadata } from "../apps/types.js";
import type { Logger } from "../logger.js";
import type { FavorService } from "./types.js";
import { favorAppIdentity } from "./rome-cloud-service.js";
import type { FavorRequiredActionDefinition } from "@rome-os/app-runtime";

interface ActionCatalogForFavorSync {
  list(): string[];
  get(name: string): Action | undefined;
  getMetadata(name: string): ArtifactMetadata | undefined;
}

export function favorActionRequirementsForApp(
  app: ResolvedApp,
  actionCatalog: ActionCatalogForFavorSync,
): FavorRequiredActionDefinition[] {
  const definitions: FavorRequiredActionDefinition[] = [];
  for (const actionName of actionCatalog.list().sort()) {
    const action = actionCatalog.get(actionName);
    const metadata = actionCatalog.getMetadata(actionName);
    if (!action || !metadata) continue;
    if (metadata.ownerType !== "app" || metadata.ownerId !== app.appId) continue;

    const requirement = action.config.favorRequirement;
    if (!requirement) continue;
    if (!action.inputSchema) {
      throw new Error(`Favor-required action "${action.config.name}" must expose inputSchema`);
    }

    definitions.push({
      actionName: action.config.name,
      amount: requirement.amount,
      title: requirement.title,
      summary: requirement.summary,
      argsSchema: action.inputSchema,
      displayFields: requirement.displayFields ?? [],
    });
  }
  return definitions;
}

export async function syncFavorActionRequirementsForApp(
  favorService: FavorService,
  app: ResolvedApp,
  actionCatalog: ActionCatalogForFavorSync,
): Promise<void> {
  await favorService.syncActionRequirements({
    appId: app.appId,
    requesterAppIdentity: favorAppIdentity(app),
    definitions: favorActionRequirementsForApp(app, actionCatalog),
  });
}

export async function syncFavorActionRequirementsFromCatalog(
  favorService: FavorService,
  appCatalog: Pick<AppCatalog, "listResolved">,
  actionCatalog: ActionCatalogForFavorSync,
  log: Logger,
): Promise<void> {
  for (const app of appCatalog.listResolved()) {
    try {
      await syncFavorActionRequirementsForApp(favorService, app, actionCatalog);
    } catch (err) {
      log.debug("favor action-requirement sync skipped", {
        appId: app.appId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function syncFavorActionRequirementsForCatalogEvent(
  favorService: FavorService,
  event: CatalogEvent,
  actionCatalog: ActionCatalogForFavorSync,
  log: Logger,
): Promise<void> {
  try {
    if (isResolvedApp(event.current)) {
      await syncFavorActionRequirementsForApp(favorService, event.current, actionCatalog);
      return;
    }
    await favorService.syncActionRequirements({
      appId: event.appId,
      requesterAppIdentity: {
        appId: event.appId,
        state: event.current?.state ?? "removed",
      },
      definitions: [],
    });
  } catch (err) {
    log.debug("favor action-requirement sync skipped", {
      appId: event.appId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
