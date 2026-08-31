import { cleanup, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Alert, AlertDescription, AlertTitle } from "./alert.js";
import { mountShadowApp } from "./test/shadow-app.js";

// Unmount React roots before wiping the shadow host the last test appends
// directly to document.body.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** Class names on a test node, as tokens — so `bg-info-bg` never reads as `bg-info`. */
function classes(testId: string): string[] {
  return [...screen.getByTestId(testId).classList];
}

describe("Alert", () => {
  it("announces itself to assistive tech as an alert", () => {
    render(
      <Alert>
        <AlertTitle>Disconnected</AlertTitle>
        <AlertDescription>GitHub needs to be reconnected.</AlertDescription>
      </Alert>,
    );

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Disconnected")).toBeDefined();
    expect(within(alert).getByText("GitHub needs to be reconnected.")).toBeDefined();
  });

  it.each([
    ["default", ["border-border", "bg-surface", "text-foreground"]],
    ["info", ["border-info-border", "bg-info-bg", "text-info-fg"]],
    ["success", ["border-success-border", "bg-success-bg", "text-success-fg"]],
    ["warning", ["border-warning-border", "bg-warning-bg", "text-warning-fg"]],
    ["destructive", ["border-destructive-border", "bg-destructive-bg", "text-destructive-fg"]],
  ] as const)("paints the %s variant from its own token trio", (variant, tokens) => {
    render(<Alert data-testid="alert" variant={variant} />);

    for (const token of tokens) {
      expect(classes("alert")).toContain(token);
    }
  });

  it.each([
    "info",
    "success",
    "warning",
    "destructive",
  ] as const)("re-inks the %s description off the muted pairing", (variant) => {
    render(<Alert data-testid="alert" variant={variant} />);

    expect(classes("alert")).toContain("[--alert-description-color:var(--foreground)]");
  });

  it("lets a caller's own text color win over the description tone", () => {
    render(
      <Alert variant="destructive">
        <AlertDescription data-testid="description" className="text-destructive-fg" />
      </Alert>,
    );

    expect(classes("description")).toContain("text-destructive-fg");
    expect(classes("description")).not.toContain(
      "text-[color:var(--alert-description-color,var(--muted-foreground))]",
    );
  });

  it("defaults to the neutral variant when none is asked for", () => {
    render(<Alert data-testid="alert" />);

    expect(classes("alert")).toContain("bg-surface");
  });

  it("lets a caller's own fill win over the variant's", () => {
    render(<Alert data-testid="alert" variant="destructive" className="bg-surface-muted" />);

    expect(classes("alert")).toContain("bg-surface-muted");
    expect(classes("alert")).not.toContain("bg-destructive-bg");
  });

  it("forwards DOM attributes and the ref to the alert element", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Alert ref={ref} id="reconnect" aria-label="Reconnect GitHub" />);

    const alert = screen.getByLabelText("Reconnect GitHub");
    expect(alert.id).toBe("reconnect");
    expect(ref.current).toBe(alert);
  });

  it("puts the title and description in the icon-adjacent column", () => {
    render(
      <Alert>
        <AlertTitle data-testid="title">Disconnected</AlertTitle>
        <AlertDescription data-testid="description">Reconnect to continue.</AlertDescription>
      </Alert>,
    );

    expect(classes("title")).toContain("col-start-2");
    expect(classes("title")).toContain("text-ui");
    expect(classes("description")).toContain(
      "text-[color:var(--alert-description-color,var(--muted-foreground))]",
    );
    expect(classes("description")).toContain("col-start-2");
    expect(classes("description")).toContain("text-ui");
  });

  it("renders inside the app's shadow root, under the theme scope", () => {
    const { appBody, mountRoot } = mountShadowApp();
    appBody.classList.add("dark");

    render(
      <Alert variant="destructive">
        <AlertTitle>Disconnected</AlertTitle>
      </Alert>,
      { container: mountRoot },
    );

    // An app's compiled CSS lives in its shadow root, and the theme classes sit
    // on the app <body> — anything rendered outside that would paint unstyled.
    const alert = mountRoot.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(appBody.contains(alert)).toBe(true);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });
});
