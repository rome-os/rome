import { describe, expect, it, rs } from "@rstest/core";
import type { AppLifecycle } from "@rome-os/app-runtime";
import type { AppStoreReader } from "../app-store-common.js";
import { appManagement } from "./index.js";

const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

function makeStore(): AppStoreReader {
  return {
    listListings: rs.fn(),
    getListing: rs.fn(async () => ({
      status: 200,
      body: {
        available: true,
        browseOrigin: "https://store.example",
        listing: {
          id: "calendar",
          handle: "rome",
          slug: "calendar",
          name: "Calendar",
          description: "Calendar tools",
          iconUrl: null,
          categories: ["productivity"],
          installCount: 12,
          highestVersion: "2.0.0",
          verified: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        versions: [
          {
            version: "1.0.0",
            contentHash: HASH_1,
            sizeBytes: 100,
            state: "live" as const,
            publishedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            version: "2.0.0",
            contentHash: HASH_2,
            sizeBytes: 200,
            state: "live" as const,
            publishedAt: "2026-02-01T00:00:00.000Z",
          },
          {
            version: "0.9.0",
            contentHash: "9".repeat(64),
            sizeBytes: 90,
            state: "revoked" as const,
            publishedAt: "2025-12-01T00:00:00.000Z",
          },
        ],
      },
    })),
  };
}

function makeAppManager(installResult: unknown = null): AppLifecycle {
  const result =
    installResult ??
    ({
      appId: "calendar",
      state: "installed",
      installedHash: HASH_2,
      installedVersion: "2.0.0",
      error: null,
    } as const);
  return {
    create: rs.fn(),
    install: rs.fn(async () => result),
    uninstall: rs.fn(),
    setEnabled: rs.fn(),
  };
}

describe("appManagement", () => {
  it("forwards a Store pin directly to create without installing or changing the source", async () => {
    const appManager = makeAppManager();
    const from = { listingId: "calendar", version: "1.0.0", contentHash: HASH_1 };
    await appManagement(
      { op: "create", appId: "ray-calendar", name: "@ray/calendar", from },
      { appManager, appStore: makeStore() },
    );
    expect(appManager.create).toHaveBeenCalledWith({
      appId: "ray-calendar",
      name: "@ray/calendar",
      from,
    });
    expect(appManager.install).not.toHaveBeenCalled();
    expect(appManager.uninstall).not.toHaveBeenCalled();
    expect(appManager.setEnabled).not.toHaveBeenCalled();
  });

  it("forwards the expected source pin and canonical source id to copy", async () => {
    const appManager = makeAppManager();
    const from = {
      appId: "@alice/calendar",
      expectedSource: {
        listingId: "@alice/calendar",
        version: "1.0.0",
        contentHash: HASH_1,
      },
    };
    await appManagement(
      { op: "create", appId: "ray-calendar", name: "@ray/calendar", from },
      { appManager, appStore: makeStore() },
    );
    expect(appManager.create).toHaveBeenCalledWith({
      appId: "ray-calendar",
      name: "@ray/calendar",
      from,
    });
  });
  it("forwards a remix create as the distinct create-from shape", async () => {
    const appManager = makeAppManager();
    rs.mocked(appManager.create).mockResolvedValue({
      appId: "ray-calendar",
      created: true,
      rootPath: "/projects/apps/ray-calendar",
    });

    const result = await appManagement(
      {
        op: "create",
        appId: "ray-calendar",
        name: "@ray/calendar",
        from: { appId: "calendar" },
      },
      { appStore: makeStore(), appManager },
    );

    expect(result).toEqual({
      status: "ok",
      data: {
        appId: "ray-calendar",
        created: true,
        rootPath: "/projects/apps/ray-calendar",
      },
    });
    expect(appManager.create).toHaveBeenCalledWith({
      appId: "ray-calendar",
      name: "@ray/calendar",
      from: { appId: "calendar" },
    });
  });

  it("keeps the existing template create shape unchanged", async () => {
    const appManager = makeAppManager();

    await appManagement(
      {
        op: "create",
        appId: "calendar-copy",
        rootPath: "/projects/apps/calendar-copy",
        template: "default",
      },
      { appStore: makeStore(), appManager },
    );

    expect(appManager.create).toHaveBeenCalledWith({
      appId: "calendar-copy",
      rootPath: "/projects/apps/calendar-copy",
      template: "default",
    });
  });

  it("does not report install success before the lifecycle install completes", async () => {
    let finishInstall!: (result: unknown) => void;
    const installResult = new Promise<unknown>((resolve) => {
      finishInstall = resolve;
    });
    const appManager = makeAppManager();
    appManager.install = rs.fn(() => installResult);

    let actionSettled = false;
    const action = appManagement(
      { op: "install", source: { mode: "bundle", path: "/tmp/calendar-bundle" } },
      { appStore: makeStore(), appManager },
    ).finally(() => {
      actionSettled = true;
    });

    await Promise.resolve();
    expect(actionSettled).toBe(false);

    finishInstall({
      appId: "calendar",
      state: "installed",
      installedHash: HASH_2,
      installedVersion: "2.0.0",
      error: null,
    });

    await expect(action).resolves.toEqual({
      status: "ok",
      data: {
        appId: "calendar",
        state: "installed",
        installedHash: HASH_2,
        installedVersion: "2.0.0",
        error: null,
      },
    });
    expect(actionSettled).toBe(true);
  });

  it("resolves an omitted Store version to the latest live version", async () => {
    const appStore = makeStore();
    const appManager = makeAppManager();

    const result = await appManagement(
      { op: "install", source: { mode: "appstore", listingId: "calendar" }, enabled: true },
      { appStore, appManager },
    );

    expect(result.status).toBe("ok");
    expect(appStore.getListing).toHaveBeenCalledWith({
      listingId: "calendar",
      includeInstalledState: true,
    });
    expect(appManager.install).toHaveBeenCalledWith({
      source: {
        mode: "appstore",
        listingId: "calendar",
        version: "2.0.0",
        contentHash: HASH_2,
      },
      enabled: true,
    });
  });

  it("resolves a requested historical Store version when it is still live", async () => {
    const appStore = makeStore();
    const appManager = makeAppManager();

    const result = await appManagement(
      { op: "install", source: { mode: "appstore", listingId: "calendar", version: "1.0.0" } },
      { appStore, appManager },
    );

    expect(result.status).toBe("ok");
    expect(appManager.install).toHaveBeenCalledWith({
      source: {
        mode: "appstore",
        listingId: "calendar",
        version: "1.0.0",
        contentHash: HASH_1,
      },
      enabled: undefined,
    });
  });

  it("rejects a requested Store version that is not live", async () => {
    const appStore = makeStore();
    const appManager = makeAppManager();

    const result = await appManagement(
      { op: "install", source: { mode: "appstore", listingId: "calendar", version: "0.9.0" } },
      { appStore, appManager },
    );

    expect(result).toEqual({
      status: "error",
      error: "Version 0.9.0 is not a live version for listing calendar.",
    });
    expect(appManager.install).not.toHaveBeenCalled();
  });

  it("returns an action error when lifecycle install records a failed state", async () => {
    const appStore = makeStore();
    const appManager = makeAppManager({
      appId: "calendar",
      state: "failed",
      installedHash: null,
      installedVersion: null,
      error: { message: "download failed" },
    });

    const result = await appManagement(
      { op: "install", source: { mode: "appstore", listingId: "calendar" } },
      { appStore, appManager },
    );

    expect(result).toEqual({
      status: "error",
      error: "Failed to install Store listing calendar as app calendar: download failed",
    });
  });
});
