import { describe, expect, it } from "@rstest/core";
import { APP_SHIMS_KEY, type AppShimRecord, readAppShims, saveAppShim } from "./store";

function memory(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(APP_SHIMS_KEY, initial);
  return {
    values,
    read: (key: string) => values.get(key) ?? null,
    write: (key: string, value: string) => void values.set(key, value),
  };
}

const record = (over: Partial<AppShimRecord> = {}): AppShimRecord => ({
  installId: "0123456789ab",
  appId: "recipes",
  url: "https://ray.romeos.cc/full/apps/recipes",
  name: "Recipes",
  bundlePath: "/Users/me/Desktop/Recipes.app",
  cdhash: "0123456789abcdef0123456789abcdef01234567",
  ...over,
});

describe("app shim records", () => {
  it("reads nothing from a missing or broken value", () => {
    expect(readAppShims(memory())).toEqual([]);
    expect(readAppShims(memory("not json"))).toEqual([]);
    expect(readAppShims(memory("{}"))).toEqual([]);
  });

  it("drops a record that does not hold up, and keeps the rest", () => {
    const good = record();
    const settings = memory(JSON.stringify([good, { ...good, cdhash: "short" }, 3]));
    expect(readAppShims(settings)).toEqual([good]);
  });

  it("replaces the record for the same bundle, and keeps other copies", () => {
    const settings = memory();
    saveAppShim(settings, record());
    saveAppShim(
      settings,
      record({ installId: "aaaaaaaaaaaa", bundlePath: "/Users/me/Desktop/Recipes 2.app" }),
    );
    saveAppShim(settings, record({ installId: "bbbbbbbbbbbb" }));
    expect(readAppShims(settings).map((r) => [r.installId, r.bundlePath])).toEqual([
      ["aaaaaaaaaaaa", "/Users/me/Desktop/Recipes 2.app"],
      ["bbbbbbbbbbbb", "/Users/me/Desktop/Recipes.app"],
    ]);
  });
});
