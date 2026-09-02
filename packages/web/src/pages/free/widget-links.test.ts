import { describe, expect, it } from "@rstest/core";
import type { WidgetPlacement } from "./use-free-cells";
import { buildFullAppPath, getWidgetFullHref } from "./widget-links";

function placement(overrides: Partial<WidgetPlacement> & { type: WidgetPlacement["type"] }) {
  return { id: "w1", order: 1, ...overrides } as WidgetPlacement;
}

describe("buildFullAppPath", () => {
  it("addresses the app root when no route or params are set", () => {
    expect(buildFullAppPath("skills")).toBe("/full/apps/skills");
  });

  it("rides the route on the path and the params on the query", () => {
    expect(buildFullAppPath("shop", "orders/detail", { orderId: 7, draft: true })).toBe(
      "/full/apps/shop/orders/detail?orderId=7&draft=true",
    );
  });

  it("encodes each route segment and the app id", () => {
    expect(buildFullAppPath("my app", "a b/c#d")).toBe("/full/apps/my%20app/a%20b/c%23d");
  });
});

describe("getWidgetFullHref", () => {
  it("addresses the projects root when no path is selected", () => {
    expect(getWidgetFullHref(placement({ type: "projects" }))).toBe("/projects");
  });

  it("carries the selected file or folder into the projects URL", () => {
    expect(
      getWidgetFullHref(placement({ type: "projects", selectedPath: "projects/docs/a b.md" })),
    ).toBe("/projects/docs/a%20b.md");
  });

  it("addresses the desktop page for the browser widget", () => {
    expect(getWidgetFullHref(placement({ type: "desktop" }))).toBe("/desktop");
  });

  it("addresses the full app view with the stored route and params", () => {
    expect(
      getWidgetFullHref(
        placement({ type: "app", targetId: "shop", route: "orders", params: { orderId: "7" } }),
      ),
    ).toBe("/full/apps/shop/orders?orderId=7");
  });

  it("returns null for widgets with no standalone page", () => {
    expect(getWidgetFullHref(placement({ type: "chat" }))).toBeNull();
    expect(getWidgetFullHref(placement({ type: "app" }))).toBeNull();
  });
});
