import type { AppCatalog } from "../apps/catalog.js";
import type { CatalogEvent } from "../apps/state.js";
import type { AgentLoader } from "../core/agent-loader.js";
import { createLogger } from "../logger.js";

const log = createLogger("webchat-default-agent");

/**
 * The Webchat default agent, one row per Rome instance. Only the dashboard's
 * new-chat draft applies it: a session created without an agent still runs
 * Rome's main agent, so app and automation callers keep their meaning.
 */
export const WEBCHAT_DEFAULT_AGENT_SETTING = "webchatDefaultAgent";

/** Owner id the agent loader gives Rome's built-in agents. No app lifecycle removes them. */
const CORE_OWNER_ID = "core";

export interface SavedWebchatDefaultAgent {
  /** Canonical agent id, e.g. `coding:coding`. */
  agentName: string;
  /** Owning app, recorded at save time: once the agent unloads, the loader can no longer name it. */
  ownerAppId: string;
}

export interface WebchatDefaultAgentStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  /** The settings table rejects null, so unset is a row delete. */
  delete(key: string): Promise<void>;
}

export function parseSavedDefaultAgent(raw: unknown): SavedWebchatDefaultAgent | null {
  if (!raw || typeof raw !== "object") return null;
  const { agentName, ownerAppId } = raw as Record<string, unknown>;
  if (typeof agentName !== "string" || !agentName) return null;
  if (typeof ownerAppId !== "string" || !ownerAppId) return null;
  return { agentName, ownerAppId };
}

export async function readSavedDefaultAgent(
  store: WebchatDefaultAgentStore,
): Promise<SavedWebchatDefaultAgent | null> {
  return parseSavedDefaultAgent(await store.get<unknown>(WEBCHAT_DEFAULT_AGENT_SETTING));
}

/** The saved agent while it is loaded, otherwise main. Reading never clears the row. */
export function effectiveDefaultAgent(
  saved: SavedWebchatDefaultAgent | null,
  agentLoader: Pick<AgentLoader, "has">,
): string {
  return saved && agentLoader.has(saved.agentName) ? saved.agentName : "main";
}

/**
 * Whether a catalog event means the saved agent's owner was uninstalled or
 * disabled. Every other state keeps the row: an app mid-install, mid-uninstall,
 * broken, or failed is not a guardian removal, and the agent loader is not
 * consulted because it lags the catalog during boot and reinstalls.
 */
export function shouldClearOnCatalogEvent(
  event: CatalogEvent,
  saved: SavedWebchatDefaultAgent,
): boolean {
  if (event.appId !== saved.ownerAppId) return false;
  if (event.change === "removed") return true;
  const view = event.current;
  return view?.state === "installed" && view.enabled === false;
}

/** Register after the agent loader's subscriber. */
export function createWebchatDefaultAgentSubscriber(store: WebchatDefaultAgentStore) {
  return async function webchatDefaultAgentSubscriber(event: CatalogEvent): Promise<void> {
    try {
      const saved = await readSavedDefaultAgent(store);
      if (!saved || !shouldClearOnCatalogEvent(event, saved)) return;
      await store.delete(WEBCHAT_DEFAULT_AGENT_SETTING);
      log.info("webchat_default_agent_cleared", {
        agentName: saved.agentName,
        ownerAppId: saved.ownerAppId,
        change: event.change,
        cause: event.change === "removed" ? "uninstalled" : "disabled",
      });
    } catch (err) {
      log.warn("webchat default agent removal check failed", {
        appId: event.appId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Catch removals the event path missed, such as a crash between an uninstall's
 * lockfile write and its final catalog event. Run once, after the app manager
 * and first-party installs have converged, so an absent owner is truly gone.
 */
export async function reconcileWebchatDefaultAgentAtBoot(
  store: WebchatDefaultAgentStore,
  appCatalog: Pick<AppCatalog, "get">,
): Promise<void> {
  const saved = await readSavedDefaultAgent(store);
  if (!saved || saved.ownerAppId === CORE_OWNER_ID) return;
  const owner = appCatalog.get(saved.ownerAppId);
  const disabled = owner?.state === "installed" && owner.enabled === false;
  if (owner && !disabled) return;
  await store.delete(WEBCHAT_DEFAULT_AGENT_SETTING);
  log.info("webchat_default_agent_cleared", {
    agentName: saved.agentName,
    ownerAppId: saved.ownerAppId,
    cause: owner ? "disabled_at_boot" : "absent_at_boot",
  });
}
