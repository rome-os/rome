import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Button } from "./button.js";
import { Spinner } from "./spinner.js";
import { mountShadowApp } from "./test/shadow-app.js";

// Unmount React roots before wiping the shadow host the last test appends
// directly to document.body.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function classesOf(status: Element): string[] {
  return [...status.classList.values()];
}

describe("Spinner", () => {
  it("announces itself as a status with a default name", () => {
    render(<Spinner />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeDefined();
  });

  it("takes the caller's name when the wait has a better description", () => {
    render(<Spinner label="Installing app" />);

    expect(screen.getByRole("status", { name: "Installing app" })).toBeDefined();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("sizes xs, sm, and md to the icon slot of the control step they sit beside", () => {
    render(
      <>
        <Spinner size="xs" label="extra small" />
        <Spinner size="sm" label="small" />
        <Spinner size="md" label="medium" />
      </>,
    );

    expect(classesOf(screen.getByRole("status", { name: "extra small" }))).toContain("size-3");
    expect(classesOf(screen.getByRole("status", { name: "small" }))).toContain("size-3.5");
    expect(classesOf(screen.getByRole("status", { name: "medium" }))).toContain("size-4");
  });

  it("defaults to the md step", () => {
    render(<Spinner />);

    expect(classesOf(screen.getByRole("status"))).toContain("size-4");
  });

  it("keeps its own step inside a Button rather than the button's icon slot", () => {
    // Button sizes bare glyphs with `[&_svg:not([class*='size-'])]:size-*`. The
    // Spinner carries a `size-` class, so that rule skips it and the step the
    // caller asked for is what renders.
    render(
      <Button size="sm">
        <Spinner size="sm" />
        Saving
      </Button>,
    );

    expect(classesOf(screen.getByRole("status"))).toContain("size-3.5");
  });

  it("lets a caller resize it", () => {
    render(<Spinner className="size-8" />);

    expect(classesOf(screen.getByRole("status"))).toContain("size-8");
    expect(classesOf(screen.getByRole("status"))).not.toContain("size-4");
  });

  it("takes no color of its own, so it inherits the tone it sits in", () => {
    render(
      <span className="text-destructive">
        <Spinner />
      </span>,
    );

    expect(classesOf(screen.getByRole("status")).some((token) => token.startsWith("text-"))).toBe(
      false,
    );
  });

  it("slows the spin under prefers-reduced-motion instead of dropping it", () => {
    // A removed animation leaves a glyph that looks like a static icon — the
    // affordance has to survive the preference, just calmer.
    render(<Spinner />);
    const tokens = classesOf(screen.getByRole("status"));

    expect(tokens).toContain("animate-spin");
    expect(tokens).toContain("motion-reduce:[animation-duration:2s]");
    expect(tokens).not.toContain("motion-reduce:animate-none");
  });

  it("forwards DOM attributes and the ref to the status element", () => {
    const ref = createRef<SVGSVGElement>();
    render(<Spinner ref={ref} id="install-progress" data-testid="spinner" />);

    const status = screen.getByTestId("spinner");
    expect(status.id).toBe("install-progress");
    expect(ref.current).toBe(status);
  });

  it("renders inside the app's shadow root, under the theme scope", () => {
    const { appBody, mountRoot } = mountShadowApp();
    appBody.classList.add("dark");

    render(<Spinner />, { container: mountRoot });

    // An app's compiled CSS lives in its shadow root and the theme classes sit
    // on the app <body>; anything rendered outside that would paint unstyled.
    const status = mountRoot.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(appBody.contains(status)).toBe(true);
    expect(document.body.querySelector('[role="status"]')).toBeNull();
  });
});
