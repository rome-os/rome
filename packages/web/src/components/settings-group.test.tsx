// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { SettingsGroup, SettingsGroupFooter } from "./settings-group";

afterEach(cleanup);

describe("SettingsGroup", () => {
  it("insets the group heading to the 16px row column in muted aux type with an 8px gap", () => {
    render(
      <SettingsGroup title="System">
        <div>Row content</div>
      </SettingsGroup>,
    );

    const region = screen.getByRole("region", { name: "System" });
    const heading = screen.getByRole("heading", { level: 2, name: "System" });
    const header = heading.parentElement;

    expect(region.className).toContain("gap-2");
    expect(region.className).not.toContain("gap-3");
    expect(header?.className).toContain("px-4");
    expect(heading.className).toContain("text-aux");
    expect(heading.className).toContain("text-muted-foreground");
    expect(heading.className).not.toContain("text-section");
    expect(heading.className).not.toContain("text-foreground");
  });

  it("preserves an explicit heading id and wires aria-labelledby to it", () => {
    render(
      <SettingsGroup title="Connection" titleId="device-connection-title">
        <div>Status</div>
      </SettingsGroup>,
    );

    const region = screen.getByRole("region", { name: "Connection" });
    const heading = screen.getByRole("heading", { level: 2, name: "Connection" });

    expect(heading.id).toBe("device-connection-title");
    expect(region.getAttribute("aria-labelledby")).toBe("device-connection-title");
  });

  it("renders SettingsGroupFooter aligned to the same 16px inset in muted aux type", () => {
    render(
      <SettingsGroup title="Model ID mappings">
        <div>Rows</div>
        <SettingsGroupFooter>Leave a field blank to use the default model ID.</SettingsGroupFooter>
      </SettingsGroup>,
    );

    const footer = screen.getByText("Leave a field blank to use the default model ID.");
    expect(footer.tagName).toBe("P");
    expect(footer.className).toContain("px-4");
    expect(footer.className).toContain("text-aux");
    expect(footer.className).toContain("text-muted-foreground");
  });
});
