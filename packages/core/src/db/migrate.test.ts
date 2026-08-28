import { afterEach, describe, expect, it } from "@rstest/core";
import { getSystemMigrationsPath, isMigrateCliEntrypoint } from "./migrate.js";

describe("getSystemMigrationsPath", () => {
  const originalProjectRoot = process.env.ROME_PROJECT_ROOT;

  afterEach(() => {
    if (originalProjectRoot === undefined) {
      delete process.env.ROME_PROJECT_ROOT;
      return;
    }
    process.env.ROME_PROJECT_ROOT = originalProjectRoot;
  });

  it("resolves from the configured core root", () => {
    process.env.ROME_PROJECT_ROOT = "/app";

    expect(getSystemMigrationsPath()).toBe("/app/packages/core/drizzle/system");
  });
});

describe("isMigrateCliEntrypoint", () => {
  it("matches source and compiled migration entrypoints", () => {
    expect(isMigrateCliEntrypoint(["node", "src/db/migrate.ts"])).toBe(true);
    expect(isMigrateCliEntrypoint(["node", "dist/db/migrate.js"])).toBe(true);
    expect(isMigrateCliEntrypoint(["node", "/app/packages/core/src/db/migrate.ts"])).toBe(true);
    expect(isMigrateCliEntrypoint(["node", "/app/packages/core/dist/db/migrate.js"])).toBe(true);
  });

  it("does not match bundled core entrypoints", () => {
    expect(isMigrateCliEntrypoint(["node", "/app/packages/core/dist/index.js"])).toBe(false);
    expect(isMigrateCliEntrypoint(["node", "/app/packages/core/dist/daemon/index.js"])).toBe(false);
  });
});
