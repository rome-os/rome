import type { ApiDeps } from "../api/deps.js";
import { getBuildInfo, type BuildInfo } from "../build-info.js";
import { LAST_BOOTED_VERSION_KEY } from "./boot-version-report.js";
import { createLogger } from "../logger.js";
import { isCompleteRelaySetting, RELAY_SETTING_KEY } from "../relay/settings.js";

const log = createLogger("diagnostics");

// The slice of ApiDeps needed to read the cheap, already-known local health
// signals. Deliberately narrow so both the /diagnosis probe and the feedback
// relay can assemble the bundle without dragging in unrelated wiring.
export type DiagnosticsDeps = Pick<
  ApiDeps,
  "settingsRepo" | "channelsService" | "appCatalog" | "bootVersionReport"
>;

export interface DiagnosticBundle {
  build: BuildInfo;
  uptimeSeconds: number;
  upgradedSinceLastBoot: boolean;
  previousVersion: string | null;
  database: { ok: boolean };
  relay: { configured: boolean; depositUrlConfigured: boolean };
  channels: string[];
  apps: { total: number; failed: string[]; broken: string[] };
}

// The local, network-free half of instance diagnostics: build identity, uptime,
// DB liveness, and app health. Deliberately excludes the Rome Cloud identity
// probe (the /diagnosis route adds that itself, and the feedback relay is
// already token-authed to Rome Cloud, so identity there is redundant) — keeping
// this pure-local makes it fast and trivially testable.
export async function assembleDiagnosticBundle(deps: DiagnosticsDeps): Promise<DiagnosticBundle> {
  const build = getBuildInfo();

  // DB liveness: a real read through the repository layer (dialect-agnostic). A
  // throw means the instance can't reach its own database. The raw driver error
  // can embed a connection string, so it goes to the logs only; the bundle
  // carries just the boolean.
  let database: { ok: boolean };
  let relay: { configured: boolean; depositUrlConfigured: boolean };
  try {
    await deps.settingsRepo.get(LAST_BOOTED_VERSION_KEY);
    database = { ok: true };
    const relaySetting = await deps.settingsRepo.get<unknown>(RELAY_SETTING_KEY);
    const relayConfigured = isCompleteRelaySetting(relaySetting);
    relay = {
      configured: relayConfigured,
      depositUrlConfigured:
        relayConfigured &&
        typeof relaySetting.depositUrl === "string" &&
        relaySetting.depositUrl.length > 0,
    };
  } catch (err) {
    log.error("diagnostics db probe failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    database = { ok: false };
    relay = { configured: false, depositUrlConfigured: false };
  }

  // Apps stuck in failed/broken loaded with errors — a degraded, but running,
  // instance. Transient installing/uninstalling states are not faults.
  const apps = deps.appCatalog.list();
  const failed = apps.filter((a) => a.state === "failed").map((a) => a.appId);
  const broken = apps.filter((a) => a.state === "broken").map((a) => a.appId);
  const channels = await deps.channelsService.list();

  return {
    build,
    uptimeSeconds: Math.round(process.uptime()),
    upgradedSinceLastBoot: deps.bootVersionReport.upgradedSinceLastBoot,
    previousVersion: deps.bootVersionReport.previousVersion,
    database,
    relay,
    channels: channels
      .filter((channel) => channel.connectionIds.length > 0)
      .map((channel) => channel.name),
    apps: { total: apps.length, failed, broken },
  };
}
