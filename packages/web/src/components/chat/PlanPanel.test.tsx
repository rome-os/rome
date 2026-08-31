// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanPanel } from "./PlanPanel";

afterEach(() => cleanup());

describe("PlanPanel", () => {
  it("shows provider activity wording and accessible three-state steps while live", () => {
    const { container } = render(
      <PlanPanel
        live
        plan={{
          explanation: "Implementing the requested workflow",
          steps: [
            { text: "Inspect the provider", status: "completed" },
            {
              text: "Build the panel",
              activeText: "Building the plan panel",
              status: "in_progress",
            },
            { text: "Verify in browser", status: "pending" },
          ],
        }}
      />,
    );

    expect(screen.getByLabelText("Agent plan").textContent).toContain("PlanIn progress1 of 3");
    expect(screen.getByText("Building the plan panel")).toBeTruthy();
    expect(screen.getByLabelText("Completed: Inspect the provider")).toBeTruthy();
    const activeStep = screen.getByLabelText("In progress: Building the plan panel");
    expect(activeStep).toBeTruthy();
    expect(activeStep.lastElementChild?.classList.contains("shimmer")).toBe(true);
    expect(screen.getByLabelText("Pending: Verify in browser")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /Plan In progress 1 of 3/ });
    const collapseMarker = container.querySelector("[data-collapse-marker]");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(collapseMarker?.classList.contains("rotate-90")).toBe(true);
    expect(
      screen.getByText("In progress: Building the plan panel").classList.contains("sr-only"),
    ).toBe(true);

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(collapseMarker?.classList.contains("rotate-90")).toBe(false);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("collapses a completed settled Plan by default and toggles its steps", () => {
    const { container } = render(
      <PlanPanel
        live={false}
        plan={{
          steps: [
            { text: "Inspect", status: "completed" },
            { text: "Implement", status: "completed" },
          ],
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: /Plan Completed 2 of 2/ });
    const collapseMarker = toggle.querySelector("[data-collapse-marker]");
    const planHeading = screen.getByRole("heading", { name: "Plan" });
    expect(
      collapseMarker &&
        collapseMarker.compareDocumentPosition(planHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByLabelText("Agent plan").textContent).toContain("PlanCompleted2 of 2");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Completed: Inspect")).toBeTruthy();
    expect(screen.getByLabelText("Completed: Implement")).toBeTruthy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
    expect(container.querySelector(".bg-primary")).toBeTruthy();
    expect(container.querySelector('[class*="success"]')).toBeNull();
    expect(screen.getByLabelText("Agent plan").className).toContain("w-full");
    expect(screen.getByLabelText("Agent plan").className).not.toContain("max-w-");
  });

  it("keeps an unfinished settled Plan expanded at the stopping point", () => {
    render(
      <PlanPanel
        live={false}
        plan={{
          steps: [
            { text: "Inspect", status: "completed" },
            { text: "Implement", status: "in_progress" },
          ],
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: /Plan Incomplete 1 of 2/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Agent plan").textContent).toContain("PlanIncomplete1 of 2");
    expect(
      screen
        .getByLabelText("In progress: Implement")
        .lastElementChild?.classList.contains("shimmer"),
    ).toBe(false);

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders nothing for an explicit empty Plan", () => {
    const { container } = render(<PlanPanel live plan={{ steps: [] }} />);
    expect(container.innerHTML).toBe("");
  });
});
