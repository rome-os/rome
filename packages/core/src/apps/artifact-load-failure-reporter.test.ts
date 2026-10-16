import { describe, expect, it, rs } from "@rstest/core";
import { createArtifactLoadFailureReporter } from "./artifact-load-failure-reporter.js";
import type { AppOwnedArtifactLoadFailure } from "./types.js";

function failure(
  kind: AppOwnedArtifactLoadFailure["kind"],
  publicName: string,
  error = "Invalid config",
): AppOwnedArtifactLoadFailure {
  return { kind, ownerId: "reports", publicName, sourcePath: `/apps/reports/${publicName}`, error };
}

function setup() {
  const agentFailures: AppOwnedArtifactLoadFailure[] = [];
  const actionFailures: AppOwnedArtifactLoadFailure[] = [];
  const log = { warn: rs.fn(), info: rs.fn() };
  const reporter = createArtifactLoadFailureReporter({
    sources: [
      { getRegistryLoadFailures: () => [...agentFailures] },
      { getRegistryLoadFailures: () => [...actionFailures] },
    ],
    log,
  });
  return { agentFailures, actionFailures, log, reporter };
}

describe("createArtifactLoadFailureReporter", () => {
  it("logs nothing while every artifact loads", () => {
    const { log, reporter } = setup();

    reporter.report("boot");
    reporter.report("weather");

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("warns once with every source's failures, not again while they stay the same", () => {
    const { agentFailures, actionFailures, log, reporter } = setup();
    agentFailures.push(failure("agent", "reporter"));
    actionFailures.push(failure("action", "run"));

    reporter.report("boot");
    reporter.report("weather");
    reporter.report("calendar");

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("some app artifacts failed to load", {
      trigger: "boot",
      failures: [failure("agent", "reporter"), failure("action", "run")],
    });
  });

  it("warns again with the full list when the failures change", () => {
    const { agentFailures, actionFailures, log, reporter } = setup();
    agentFailures.push(failure("agent", "reporter"));
    reporter.report("boot");

    actionFailures.push(failure("action", "run"));
    reporter.report("reports");
    agentFailures[0] = failure("agent", "reporter", "Another reason");
    reporter.report("reports");

    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenLastCalledWith("some app artifacts failed to load", {
      trigger: "reports",
      failures: [failure("agent", "reporter", "Another reason"), failure("action", "run")],
    });
  });

  it("logs one info line when the failures clear", () => {
    const { agentFailures, log, reporter } = setup();
    agentFailures.push(failure("agent", "reporter"));
    reporter.report("boot");

    agentFailures.length = 0;
    reporter.report("reports");
    reporter.report("weather");

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("app artifact load failures cleared", {
      trigger: "reports",
    });
  });
});
