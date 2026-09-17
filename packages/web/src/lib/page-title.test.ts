import { describe, expect, it } from "@rstest/core";
import { APP_NAV } from "@/shell/AppGrid";
import { composeTitle, routeTitle } from "./page-title";

describe("composeTitle", () => {
  it("appends the site name to the segments it is given", () => {
    expect(composeTitle(["Connections", "Settings"])).toBe("Connections · Settings · Rome");
    expect(composeTitle(["Chat"])).toBe("Chat · Rome");
  });

  it("returns the site name alone when nothing names the page", () => {
    expect(composeTitle([])).toBe("Rome");
    expect(composeTitle([null, undefined, "", "   "])).toBe("Rome");
  });

  it("drops the gaps rather than rendering empty separators", () => {
    expect(composeTitle([null, "Routines"])).toBe("Routines · Rome");
    expect(composeTitle(["17.md", undefined, "Memory"])).toBe("17.md · Memory · Rome");
  });

  it("trims each segment", () => {
    expect(composeTitle(["  Alice  ", " People "])).toBe("Alice · People · Rome");
  });

  it("truncates a long segment so the site name stays in view", () => {
    const long = "x".repeat(200);
    const title = composeTitle([long, "Memory"]);
    expect(title.endsWith("… · Memory · Rome")).toBe(true);
    expect(title.length).toBeLessThan(long.length);
  });
});

describe("routeTitle", () => {
  // The nav registry is the only list of named destinations. Reading it here
  // rather than restating it is what keeps a new nav entry from shipping a
  // nameless tab.
  it("names every destination the nav offers", () => {
    for (const entry of APP_NAV) {
      expect(routeTitle(entry.href, APP_NAV)).toEqual({ key: entry.labelKey, detail: null });
    }
  });

  it("lets the longest match win whatever order the registry is written in", () => {
    const registry = [
      { href: "/apps", labelKey: "nav.apps" },
      { href: "/apps/store", labelKey: "nav.store" },
    ];
    expect(routeTitle("/apps/store", registry)?.key).toBe("nav.store");
    expect(routeTitle("/apps/store", [...registry].reverse())?.key).toBe("nav.store");
    expect(routeTitle("/apps", registry)?.key).toBe("nav.apps");
    expect(routeTitle("/apps/calendar", registry)?.key).toBe("nav.apps");
  });

  it("matches on segment boundaries", () => {
    expect(routeTitle("/peopled", APP_NAV)).toBeNull();
    expect(routeTitle("/people/person/alice", APP_NAV)?.key).toBe("nav.people");
  });

  it("returns null for a path no destination owns", () => {
    expect(routeTitle("/login", APP_NAV)).toBeNull();
    expect(routeTitle("/", APP_NAV)).toBeNull();
    expect(routeTitle("/share/abc", APP_NAV)).toBeNull();
  });

  it("names the open file on the routes that browse a tree", () => {
    expect(routeTitle("/memory/journal/2026/09/17.md", APP_NAV)).toEqual({
      key: "nav.memory",
      detail: "17.md",
    });
    expect(routeTitle("/projects/rome/README.md", APP_NAV)).toEqual({
      key: "nav.projects",
      detail: "README.md",
    });
    expect(routeTitle("/memory", APP_NAV)).toEqual({ key: "nav.memory", detail: null });
  });

  it("decodes a percent-encoded file name", () => {
    expect(routeTitle("/memory/notes/Q3%20plan.md", APP_NAV)?.detail).toBe("Q3 plan.md");
  });

  it("keeps a malformed escape rather than dropping the file name", () => {
    expect(routeTitle("/memory/notes/100%.md", APP_NAV)?.detail).toBe("100%.md");
  });

  it("carries no file detail on the routes that are not file browsers", () => {
    expect(routeTitle("/routines/abc", APP_NAV)?.detail).toBeNull();
    expect(routeTitle("/settings/connections", APP_NAV)?.detail).toBeNull();
  });
});
