import type { Logger } from "../logger.js";
import type { AppOwnedArtifactLoadFailure } from "./types.js";

export interface ArtifactLoadFailureSource {
  getRegistryLoadFailures(): AppOwnedArtifactLoadFailure[];
}

export interface ArtifactLoadFailureReporter {
  /**
   * Reads every source's failures and logs them only when they differ from the
   * previous report: a warn with the full list, or one info line when the list
   * empties. `trigger` names what prompted the report, such as a catalog
   * event's app id, and is logged with it.
   */
  report(trigger: string): void;
}

/**
 * Reports the app artifacts the loaders skipped. The loaders record a skipped
 * artifact instead of throwing, so one broken app cannot block the rest, and
 * this reporter is the main process's log of those skips.
 */
export function createArtifactLoadFailureReporter(options: {
  sources: readonly ArtifactLoadFailureSource[];
  log: Pick<Logger, "warn" | "info">;
}): ArtifactLoadFailureReporter {
  let reportedKeys = new Set<string>();

  return {
    report(trigger) {
      const failures = options.sources.flatMap((source) => source.getRegistryLoadFailures());
      const keys = new Set(failures.map(failureKey));
      if (keys.size === reportedKeys.size && [...keys].every((key) => reportedKeys.has(key))) {
        return;
      }

      const hadFailures = reportedKeys.size > 0;
      reportedKeys = keys;
      if (failures.length > 0) {
        options.log.warn("some app artifacts failed to load", { trigger, failures });
      } else if (hadFailures) {
        options.log.info("app artifact load failures cleared", { trigger });
      }
    },
  };
}

function failureKey(failure: AppOwnedArtifactLoadFailure): string {
  return JSON.stringify([failure.kind, failure.ownerId, failure.publicName, failure.error]);
}
