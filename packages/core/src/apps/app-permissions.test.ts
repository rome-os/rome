import { describe, expect, it } from "@rstest/core";
import { Permissions } from "../access/permissions.js";
import { createTestDb } from "../test/db.js";
import {
  changeAppAccess,
  loadAppPermissionsSetting,
  normalizeAppPermissionsSetting,
  saveAppPermissionsSetting,
} from "./app-permissions.js";

describe("changeAppAccess", () => {
  it("changes one app's access and keeps a change another call made to another app", async () => {
    const { db, close } = createTestDb();
    const permissions = new Permissions();
    await saveAppPermissionsSetting(db, permissions, {
      allowedApps: ["notes"],
      cloudEmailAccess: {},
    });

    // Both requests arrive before either is stored, as two tool calls in flight.
    await Promise.all([
      Promise.resolve().then(() => changeAppAccess(db, permissions, "notes", { mode: "private" })),
      Promise.resolve().then(() =>
        changeAppAccess(db, permissions, "calendar", { mode: "public" }),
      ),
    ]);

    expect(await loadAppPermissionsSetting(db)).toEqual({
      allowedApps: ["calendar"],
      cloudEmailAccess: {},
    });
    expect(permissions.get("notes").anyoneWithLink).toBe(false);
    expect(permissions.get("calendar").anyoneWithLink).toBe(true);
    close();
  });
});

// A policy persisted by an earlier release can still carry the retired
// `enableAccessControl` flag. It is dropped on read.
describe("normalizeAppPermissionsSetting with a persisted legacy enableAccessControl flag", () => {
  it("normalizes without the flag and keeps the app policy", () => {
    const config = normalizeAppPermissionsSetting({
      enableAccessControl: true,
      allowedApps: ["morning-brief"],
      cloudEmailAccess: { "night-brief": ["a@b.co"] },
    });
    expect(config).toEqual({
      allowedApps: ["morning-brief"],
      cloudEmailAccess: { "night-brief": ["a@b.co"] },
    });
    expect("enableAccessControl" in config).toBe(false);
  });
});
