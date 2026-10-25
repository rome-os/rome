import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import * as loggerModule from "../logger.js" with { rstest: "importActual" };

// Spy on this module's own logger only. Every other module the test DB pulls in
// keeps the real one.
const logInfo = rs.hoisted(() => rs.fn());
const logWarn = rs.hoisted(() => rs.fn());
rs.mock("../logger.js", () => ({
  ...loggerModule,
  createLogger: (component: string, ...rest: unknown[]) =>
    component === "boot-version-report"
      ? { info: logInfo, warn: logWarn, error: rs.fn(), debug: rs.fn() }
      : loggerModule.createLogger(component, ...(rest as [])),
}));

import { createTestDb, type TestDb } from "../test/helpers.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import {
  LAST_BOOTED_VERSION_KEY,
  reportBootVersion,
  commitBootVersion,
} from "./boot-version-report.js";
import type { BuildInfo } from "../build-info.js";

function build(version: string | null): BuildInfo {
  return { version, sha: "abc1234", builtAt: "2026-06-01T00:00:00Z" };
}

function brokenSettingsRepo(): SettingsRepository {
  return {
    get: () => Promise.reject(new Error("db locked")),
    set: () => Promise.reject(new Error("db locked")),
  } as unknown as SettingsRepository;
}

describe("boot version report", () => {
  let testDb: TestDb;
  let settingsRepo: SettingsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    settingsRepo = new SettingsRepository(testDb.db);
    logInfo.mockClear();
    logWarn.mockClear();
  });

  afterEach(() => testDb.close());

  it("logs a rollback to an older release as a downgrade, not an upgrade", async () => {
    await settingsRepo.set(LAST_BOOTED_VERSION_KEY, "1.1.148");

    const report = await reportBootVersion(settingsRepo, build("1.1.147"));

    expect(report).toEqual({ upgradedSinceLastBoot: true, previousVersion: "1.1.148" });
    expect(logWarn).toHaveBeenCalledWith("rome downgraded since last boot", {
      from: "1.1.148",
      to: "1.1.147",
    });
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("compares release versions numerically, not as strings", async () => {
    await settingsRepo.set(LAST_BOOTED_VERSION_KEY, "1.1.99");

    await reportBootVersion(settingsRepo, build("1.1.100"));

    expect(logInfo).toHaveBeenCalledWith("rome upgraded since last boot", {
      from: "1.1.99",
      to: "1.1.100",
    });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("reports no upgrade on first boot and leaves the store to commitBootVersion", async () => {
    const report = await reportBootVersion(settingsRepo, build("1.2.0"));

    expect(report).toEqual({ upgradedSinceLastBoot: false, previousVersion: null });
    expect(await settingsRepo.get(LAST_BOOTED_VERSION_KEY)).toBeNull();
  });

  it("reports an upgrade when the version changed without advancing the stored one", async () => {
    await settingsRepo.set(LAST_BOOTED_VERSION_KEY, "1.1.0");

    const report = await reportBootVersion(settingsRepo, build("1.2.0"));

    expect(report).toEqual({ upgradedSinceLastBoot: true, previousVersion: "1.1.0" });
    expect(await settingsRepo.get(LAST_BOOTED_VERSION_KEY)).toBe("1.1.0");
  });

  it("still reports the upgrade after a boot that died before committing", async () => {
    await settingsRepo.set(LAST_BOOTED_VERSION_KEY, "1.1.0");

    // First boot on 1.2.0 reports the upgrade but crashes before commit.
    await reportBootVersion(settingsRepo, build("1.2.0"));

    // The retry boot on the same version must still see the upgrade.
    const retry = await reportBootVersion(settingsRepo, build("1.2.0"));
    expect(retry).toEqual({ upgradedSinceLastBoot: true, previousVersion: "1.1.0" });
  });

  it("does not report an upgrade when rebooting on the same version", async () => {
    await settingsRepo.set(LAST_BOOTED_VERSION_KEY, "1.2.0");

    const report = await reportBootVersion(settingsRepo, build("1.2.0"));

    expect(report).toEqual({ upgradedSinceLastBoot: false, previousVersion: "1.2.0" });
  });

  it("reports nothing on a source run with no release version", async () => {
    await settingsRepo.set(LAST_BOOTED_VERSION_KEY, "1.2.0");

    const report = await reportBootVersion(settingsRepo, build(null));

    expect(report).toEqual({ upgradedSinceLastBoot: false, previousVersion: null });
  });

  it("returns a no-upgrade report instead of throwing when the settings read fails", async () => {
    const report = await reportBootVersion(brokenSettingsRepo(), build("1.2.0"));

    expect(report).toEqual({ upgradedSinceLastBoot: false, previousVersion: null });
  });

  describe("commitBootVersion", () => {
    it("records the running version as the last completed boot", async () => {
      await commitBootVersion(settingsRepo, build("1.2.0"));

      expect(await settingsRepo.get(LAST_BOOTED_VERSION_KEY)).toBe("1.2.0");
    });

    it("leaves the stored version untouched on a source run", async () => {
      await settingsRepo.set(LAST_BOOTED_VERSION_KEY, "1.2.0");

      await commitBootVersion(settingsRepo, build(null));

      expect(await settingsRepo.get(LAST_BOOTED_VERSION_KEY)).toBe("1.2.0");
    });

    it("does not throw when the settings write fails", async () => {
      await expect(
        commitBootVersion(brokenSettingsRepo(), build("1.2.0")),
      ).resolves.toBeUndefined();
    });
  });
});
