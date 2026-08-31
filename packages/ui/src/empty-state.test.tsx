import { cleanup, render, screen } from "@testing-library/react";
import { Search } from "lucide-react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Button } from "./button.js";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "./empty-state.js";
import { Spinner } from "./spinner.js";
import { mountShadowApp } from "./test/shadow-app.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function ExampleEmptyState({ className }: { className?: string }) {
  return (
    <EmptyState className={className} data-testid="empty-state">
      <EmptyStateIcon>
        <Search aria-hidden />
      </EmptyStateIcon>
      <EmptyStateTitle>No apps found</EmptyStateTitle>
      <EmptyStateDescription>Try changing your search.</EmptyStateDescription>
      <EmptyStateAction>
        <Button>Clear search</Button>
      </EmptyStateAction>
    </EmptyState>
  );
}

function classesOf(element: Element): string[] {
  return [...element.classList];
}

describe("EmptyState", () => {
  it("centers itself in a fixed-height parent when the caller owns the height", () => {
    render(
      <div style={{ height: 320 }}>
        <ExampleEmptyState className="h-full" />
      </div>,
    );

    const state = screen.getByTestId("empty-state");
    expect(classesOf(state)).toEqual(
      expect.arrayContaining(["grid", "place-items-center", "h-full"]),
    );
  });

  it("keeps an intrinsic minimum height in an auto-height parent", () => {
    render(<ExampleEmptyState />);

    expect(classesOf(screen.getByTestId("empty-state"))).toContain("min-h-48");
  });

  it("associates its description with its title for assistive technology", () => {
    render(<ExampleEmptyState />);

    const state = screen.getByRole("status", { name: "No apps found" });
    const title = screen.getByRole("heading", { name: "No apps found" });
    const description = screen.getByText("Try changing your search.");

    expect(classesOf(title)).toContain("text-title");
    expect(classesOf(description)).toContain("text-body");
    expect(state.getAttribute("aria-labelledby")).toBe(title.id);
    expect(state.getAttribute("aria-describedby")).toBe(description.id);
  });

  it("keeps the association when callers provide custom IDs", () => {
    render(
      <EmptyState>
        <EmptyStateTitle id="custom-title">No apps found</EmptyStateTitle>
        <EmptyStateDescription id="custom-description">
          Try changing your search.
        </EmptyStateDescription>
      </EmptyState>,
    );

    const state = screen.getByRole("status", { name: "No apps found" });
    expect(state.getAttribute("aria-labelledby")).toBe("custom-title");
    expect(state.getAttribute("aria-describedby")).toBe("custom-description");
  });

  it("sizes and tones a bare icon consistently", () => {
    render(<ExampleEmptyState />);

    const icon = screen
      .getByText("No apps found")
      .parentElement?.querySelector('[data-slot="empty-state-icon"]');
    expect(icon).not.toBeNull();
    expect(classesOf(icon!)).toEqual(
      expect.arrayContaining(["bg-surface-muted", "text-muted-foreground", "[&_svg]:size-5"]),
    );
  });

  it("normalizes the glyph rather than defaulting it, so a Spinner matches a bare icon", () => {
    render(
      <EmptyState>
        <EmptyStateIcon data-testid="icon">
          <Spinner data-testid="spinner" label="Loading apps" />
        </EmptyStateIcon>
        <EmptyStateTitle>Loading</EmptyStateTitle>
      </EmptyState>,
    );

    // The tile is the one glyph rule in the kit with no `:not([class*='size-'])`
    // opt-out, and that is the point: Spinner tops out at the 16px `md` step, so
    // an opt-out would leave the waiting tile visibly smaller than the
    // nothing-found tile it stands in for.
    expect(classesOf(screen.getByTestId("icon"))).toContain("[&_svg]:size-5");
    expect(classesOf(screen.getByTestId("spinner"))).toContain("size-4");
  });

  it("exposes a real heading and composes an optional action", () => {
    render(<ExampleEmptyState />);

    expect(screen.getByRole("heading", { name: "No apps found" }).tagName).toBe("H3");
    expect(screen.getByRole("button", { name: "Clear search" })).toBeDefined();
  });

  it("forwards DOM attributes and the ref to the container", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <EmptyState ref={ref} id="no-routines">
        <EmptyStateTitle>No routines</EmptyStateTitle>
      </EmptyState>,
    );

    const state = screen.getByRole("status", { name: "No routines" });
    expect(state.id).toBe("no-routines");
    expect(ref.current).toBe(state);
    expect(state.hasAttribute("aria-describedby")).toBe(false);
  });

  it("renders inside a dark Rome app shadow root using theme tokens", () => {
    const { appBody, mountRoot } = mountShadowApp();
    appBody.classList.add("dark");

    render(<ExampleEmptyState />, { container: mountRoot });

    const state = mountRoot.querySelector('[data-slot="empty-state"]');
    expect(state).not.toBeNull();
    expect(appBody.contains(state)).toBe(true);
    expect(document.body.querySelector('[data-slot="empty-state"]')).toBeNull();
    expect(state?.querySelector('[data-slot="empty-state-icon"]')?.className).toContain(
      "bg-surface-muted",
    );
  });
});
