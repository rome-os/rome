import { describe, expect, it } from "@rstest/core";
import { Permissions } from "../access/permissions.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { createTestDb } from "../test/db.js";
import {
  APP_PERMISSIONS_SETTING_KEY,
  loadAppPermissionsSetting,
  normalizeAppPermissionsSetting,
  setAppAccess,
  widensAppAccess,
  type AppAccess,
} from "./app-permissions.js";

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

describe("widensAppAccess", () => {
  const priv: AppAccess = { mode: "private", emails: [] };
  const pub: AppAccess = { mode: "public", emails: [] };
  const listed = (...emails: string[]): AppAccess => ({ mode: "cloud-email", emails });

  it("is true only when someone new may open the app", () => {
    expect(widensAppAccess(priv, pub)).toBe(true);
    expect(widensAppAccess(priv, listed("a@x.co"))).toBe(true);
    expect(widensAppAccess(listed("a@x.co"), listed("a@x.co", "b@x.co"))).toBe(true);
    expect(widensAppAccess(listed("a@x.co"), pub)).toBe(true);

    expect(widensAppAccess(pub, pub)).toBe(false);
    expect(widensAppAccess(pub, listed("a@x.co"))).toBe(false);
    expect(widensAppAccess(listed("a@x.co", "b@x.co"), listed("b@x.co"))).toBe(false);
    expect(widensAppAccess(listed("a@x.co"), priv)).toBe(false);
  });
});

describe("setAppAccess", () => {
  it("keeps both of two writes to different apps made at once", async () => {
    const { db, close } = createTestDb();
    try {
      const permissions = new Permissions();
      await new SettingsRepository(db).set(APP_PERMISSIONS_SETTING_KEY, {
        allowedApps: ["notes"],
        cloudEmailAccess: {},
      });
      const deps = { db, permissions, apps: { hasPage: () => true } };
      await Promise.all([
        setAppAccess(deps, "notes", { mode: "private", emails: [] }),
        setAppAccess(deps, "other", { mode: "public", emails: [] }),
      ]);
      expect(await loadAppPermissionsSetting(db)).toEqual({
        allowedApps: ["other"],
        cloudEmailAccess: {},
      });
      expect(permissions.get("notes").anyoneWithLink).toBe(false);
    } finally {
      close();
    }
  });
});
