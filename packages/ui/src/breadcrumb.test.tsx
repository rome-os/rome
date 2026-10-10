import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { BreadcrumbEllipsis, collapseBreadcrumb } from "./breadcrumb.js";

afterEach(cleanup);

describe("collapseBreadcrumb", () => {
  const trail = ["Files", "projects", "ash-and-oak", "ledger", "2026", "q3-invoices"];

  it("keeps a trail that fits", () => {
    expect(collapseBreadcrumb(trail.slice(0, 4), 4)).toEqual({
      leading: trail.slice(0, 4),
      hidden: [],
      trailing: [],
    });
  });

  it("keeps the first crumb and the deepest, and hides the middle", () => {
    expect(collapseBreadcrumb(trail, 4)).toEqual({
      leading: ["Files"],
      hidden: ["projects", "ash-and-oak", "ledger"],
      trailing: ["2026", "q3-invoices"],
    });
  });

  it("never shows fewer than root, ellipsis and current", () => {
    expect(collapseBreadcrumb(trail, 1)).toEqual({
      leading: ["Files"],
      hidden: ["projects", "ash-and-oak", "ledger", "2026"],
      trailing: ["q3-invoices"],
    });
  });
});

describe("BreadcrumbEllipsis", () => {
  it("is a named button", () => {
    render(<BreadcrumbEllipsis label="Show 3 hidden folders" />);
    const button = screen.getByRole("button", { name: "Show 3 hidden folders" });
    expect(button.getAttribute("type")).toBe("button");
  });
});
