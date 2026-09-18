import { describe, expect, it } from "@rstest/core";
import {
  RECENT_APPS_VISIBLE,
  RECENT_APPS_WINDOW_MS,
  type RecentAppCandidate,
  isUnopened,
  lastActiveMs,
  parseAppLastOpened,
  pruneAppLastOpened,
  selectRecentApps,
} from "./recent-apps";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

function app(id: string, overrides: Partial<RecentAppCandidate> = {}): RecentAppCandidate {
  return {
    id,
    displayName: id,
    hasFrontend: true,
    href: `/apps/${id}`,
    status: "active",
    origin: "local",
    installedAt: null,
    ...overrides,
  };
}

describe("constants", () => {
  it("match the spec", () => {
    expect(RECENT_APPS_VISIBLE).toBe(3);
    expect(RECENT_APPS_WINDOW_MS).toBe(14 * DAY);
  });
});

describe("parseAppLastOpened", () => {
  it("keeps only string values that parse as dates", () => {
    expect(parseAppLastOpened({ a: iso(NOW), b: "not a date", c: 5, d: null })).toEqual({
      a: iso(NOW),
    });
  });

  it("returns an empty map for anything that is not a plain object", () => {
    expect(parseAppLastOpened(undefined)).toEqual({});
    expect(parseAppLastOpened(["x"])).toEqual({});
    expect(parseAppLastOpened("x")).toEqual({});
  });
});

describe("pruneAppLastOpened", () => {
  it("drops entries older than the window", () => {
    expect(
      pruneAppLastOpened({ keep: iso(NOW - 13 * DAY), drop: iso(NOW - 15 * DAY) }, NOW),
    ).toEqual({ keep: iso(NOW - 13 * DAY) });
  });
});

describe("lastActiveMs", () => {
  it("takes the later of install and last open", () => {
    const candidate = app("a", { installedAt: iso(NOW - 5 * DAY) });
    expect(lastActiveMs(candidate, { a: iso(NOW - DAY) })).toBe(NOW - DAY);
    expect(lastActiveMs(candidate, {})).toBe(NOW - 5 * DAY);
  });

  it("is null when there is neither signal", () => {
    expect(lastActiveMs(app("a"), {})).toBeNull();
  });

  it("ignores installedAt for built-in apps", () => {
    const builtin = app("a", { origin: "builtin", installedAt: iso(NOW) });
    expect(lastActiveMs(builtin, {})).toBeNull();
    expect(lastActiveMs(builtin, { a: iso(NOW - DAY) })).toBe(NOW - DAY);
  });
});

describe("isUnopened", () => {
  it("is true for an installed, never-opened, non-built-in app", () => {
    expect(isUnopened(app("a", { installedAt: iso(NOW) }), {})).toBe(true);
  });

  it("is false once opened, for legacy installs, and for built-ins", () => {
    expect(isUnopened(app("a", { installedAt: iso(NOW) }), { a: iso(NOW) })).toBe(false);
    expect(isUnopened(app("a"), {})).toBe(false);
    expect(isUnopened(app("a", { origin: "builtin", installedAt: iso(NOW) }), {})).toBe(false);
  });
});

describe("selectRecentApps", () => {
  const none = new Set<string>();

  it("orders by most recent activity first", () => {
    const apps = [app("old"), app("new"), app("built", { installedAt: iso(NOW - HOUR) })];
    const opened = { old: iso(NOW - 3 * DAY), new: iso(NOW - 2 * HOUR) };
    expect(selectRecentApps(apps, none, opened, NOW).map((a) => a.id)).toEqual([
      "built",
      "new",
      "old",
    ]);
  });

  it("keeps an app at 13 days 23 hours and drops it at 14 days 1 second", () => {
    const apps = [app("in"), app("out")];
    const opened = {
      in: iso(NOW - (14 * DAY - HOUR)),
      out: iso(NOW - (14 * DAY + 1000)),
    };
    expect(selectRecentApps(apps, none, opened, NOW).map((a) => a.id)).toEqual(["in"]);
  });

  it("excludes pinned, disabled, frontend-less, and signal-less apps", () => {
    const opened = { pinned: iso(NOW), off: iso(NOW), headless: iso(NOW), nolink: iso(NOW) };
    const apps = [
      app("pinned"),
      app("off", { status: "disabled" }),
      app("headless", { hasFrontend: false }),
      app("nolink", { href: null }),
      app("silent"),
    ];
    expect(selectRecentApps(apps, new Set(["pinned"]), opened, NOW)).toEqual([]);
  });

  it("does not let a freshly installed built-in app in until it is opened", () => {
    const builtin = app("sys", { origin: "builtin", installedAt: iso(NOW) });
    expect(selectRecentApps([builtin], none, {}, NOW)).toEqual([]);
    expect(selectRecentApps([builtin], none, { sys: iso(NOW) }, NOW)).toEqual([builtin]);
  });
});
