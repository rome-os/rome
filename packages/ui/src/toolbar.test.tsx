import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Button } from "./button.js";
import { Toolbar, ToolbarButton, ToolbarSeparator } from "./toolbar.js";

afterEach(cleanup);

function ExampleToolbar() {
  return (
    <Toolbar aria-label="Apps">
      <ToolbarButton asChild>
        <Button size="sm">Import</Button>
      </ToolbarButton>
      <ToolbarSeparator />
      <ToolbarButton asChild>
        <Button size="sm">Install</Button>
      </ToolbarButton>
      <ToolbarButton asChild>
        <Button size="sm">Refresh</Button>
      </ToolbarButton>
    </Toolbar>
  );
}

describe("Toolbar", () => {
  it("exposes a named toolbar role", () => {
    render(<ExampleToolbar />);

    expect(screen.getByRole("toolbar", { name: "Apps" })).toBeDefined();
  });

  it("spends one tab stop and moves between its controls with arrow keys", async () => {
    const user = userEvent.setup();
    render(<ExampleToolbar />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Import" }));

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Install" }));

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh" }));
  });

  it("leaves the control's own geometry to the control", () => {
    render(<ExampleToolbar />);

    // `asChild` merges onto the kit Button, so the toolbar hands it the roving
    // tab index and nothing else — the step and the padding stay the Button's.
    expect(screen.getByRole("button", { name: "Import" }).getAttribute("data-size")).toBe("sm");
  });
});
