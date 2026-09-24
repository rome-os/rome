// PROTOTYPE (webchat-default-agent). Throwaway code answering the brief at
// rome-work webchat-default-agent/prototype-brief.md. Not for merge.
//
// The saved Webchat default agent lives in the instance settings store under
// one key. The server never applies it: a session created without an agent is
// still the main agent (product spec D9). The server's only job is to clear the
// saved value once, durably, when the agent's owning app is truly removed or
// disabled — and never during the not-yet-loaded window (startup, reinstall).

import type { AppCatalog } from "../apps/catalog.js";
import type { CatalogEvent } from "../apps/state.js";
import type { AgentLoader } from "../core/agent-loader.js";
import { createLogger } from "../logger.js";

const log = createLogger("wda-proto");

export const WEBCHAT_DEFAULT_AGENT_SETTING = "webchatDefaultAgent";

export interface SavedWebchatDefaultAgent {
  /** Canonical artifact id, e.g. `wda-proto-app:helper`. */
  agentName: string;
  /** Owning app id, captured at save time so removal is detectable after unload. */
  ownerAppId: string;
}

interface SettingsStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  // The settings table rejects a null value, so "unset" is a row delete.
  delete(key: string): Promise<void>;
}

export function parseSavedDefault(raw: unknown): SavedWebchatDefaultAgent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.agentName !== "string" || typeof r.ownerAppId !== "string") return null;
  return { agentName: r.agentName, ownerAppId: r.ownerAppId };
}

export type RemovalDecision = { clear: true; reason: string } | { clear: false; reason: string };

/**
 * THE removal rule. Only terminal, guardian-caused states of the owning app
 * clear the default. Every transient state (installing/uninstalling overlay,
 * broken, failed install, not-yet-refreshed at boot) keeps it.
 */
export function decideOnCatalogEvent(
  event: CatalogEvent,
  saved: SavedWebchatDefaultAgent,
  agentLoader: Pick<AgentLoader, "has" | "getRegistryLoadFailures">,
): RemovalDecision {
  if (event.appId !== saved.ownerAppId) return { clear: false, reason: "other-app" };
  if (event.change === "removed") return { clear: true, reason: "owner-uninstalled" };
  const view = event.current;
  if (!view) return { clear: false, reason: "no-view" };
  if (view.state === "installed" && view.enabled === false) {
    return { clear: true, reason: "owner-disabled" };
  }
  if (view.state !== "installed") {
    // installing | uninstalling | broken | failed: the catalog does not list the
    // agent right now, but nothing the guardian did removed it (yet).
    return { clear: false, reason: `transient-state:${view.state}` };
  }
  // Installed + enabled. Deliberately NOT "agent missing from the loader →
  // clear": run 4 showed the loader reload throws at boot until `coding` loads
  // (core main references coding:planning), so a first-party default such as
  // assistant:assistant looked missing and was wrongly cleared on restart.
  return {
    clear: false,
    reason: agentLoader.has(saved.agentName)
      ? "owner-installed"
      : "owner-installed-agent-not-loaded",
  };
}

async function readSaved(settings: SettingsStore): Promise<SavedWebchatDefaultAgent | null> {
  return parseSavedDefault(await settings.get<unknown>(WEBCHAT_DEFAULT_AGENT_SETTING));
}

/** Catalog subscriber. Must be registered after the agent loader's subscriber. */
export function createWebchatDefaultAgentSubscriber(deps: {
  settingsRepo: SettingsStore;
  agentLoader: AgentLoader;
}) {
  return async function webchatDefaultAgentRemovalSubscriber(event: CatalogEvent) {
    const saved = await readSaved(deps.settingsRepo);
    if (!saved || event.appId !== saved.ownerAppId) return;
    const decision = decideOnCatalogEvent(event, saved, deps.agentLoader);
    log.info("wda_proto_catalog_event", {
      appId: event.appId,
      change: event.change,
      state: event.current?.state ?? null,
      enabled: event.current?.enabled ?? null,
      agentLoaded: deps.agentLoader.has(saved.agentName),
      saved: saved.agentName,
      decision: decision.clear ? "clear" : "keep",
      reason: decision.reason,
    });
    if (decision.clear) {
      await deps.settingsRepo.delete(WEBCHAT_DEFAULT_AGENT_SETTING);
      log.info("wda_proto_default_cleared", { saved: saved.agentName, reason: decision.reason });
    }
  };
}

/**
 * Boot reconciliation, run once after AppManager.boot() and first-party
 * convergence. Covers removals the event path could not see (crash between the
 * uninstall's lockfile write and its final refresh, lockfile edited while down).
 * At this point every lockfile entry has been refreshed into the catalog, so an
 * absent owner is truly not installed.
 */
export async function reconcileWebchatDefaultAgentAtBoot(deps: {
  settingsRepo: SettingsStore;
  appCatalog: AppCatalog;
  agentLoader: AgentLoader;
}): Promise<void> {
  const saved = await readSaved(deps.settingsRepo);
  if (!saved) {
    log.info("wda_proto_boot_reconcile", { saved: null, decision: "noop" });
    return;
  }
  const view = deps.appCatalog.get(saved.ownerAppId);
  let decision: RemovalDecision;
  if (!view) decision = { clear: true, reason: "owner-absent-after-boot" };
  else if (view.state === "installed" && view.enabled === false) {
    decision = { clear: true, reason: "owner-disabled-at-boot" };
  } else decision = { clear: false, reason: `owner-${view.state}` };
  log.info("wda_proto_boot_reconcile", {
    saved: saved.agentName,
    ownerState: view?.state ?? null,
    ownerEnabled: view?.enabled ?? null,
    agentLoaded: deps.agentLoader.has(saved.agentName),
    decision: decision.clear ? "clear" : "keep",
    reason: decision.reason,
  });
  if (decision.clear) await deps.settingsRepo.delete(WEBCHAT_DEFAULT_AGENT_SETTING);
}
