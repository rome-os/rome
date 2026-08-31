import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type FormEvent } from "react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { Button } from "./button.js";
import { mountShadowApp } from "./test/shadow-app.js";
import { Toggle, type ToggleProps } from "./toggle.js";

// Unmount React roots before wiping the shadow host the last test appends
// directly to document.body.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const SIZES = [
  "default",
  "xs",
  "sm",
  "icon",
  "icon-xs",
  "icon-sm",
  "icon-lg",
] as const satisfies readonly NonNullable<ToggleProps["size"]>[];

/**
 * The class tokens that decide the control's box — height, width, padding, gap,
 * radius, type size — under any variant prefix. `h-[var(--control-h-md)]`
 * counts, `bg-primary/15` and `border-border` don't.
 *
 * jsdom does no layout — `offsetHeight` is 0 for every element — so "same
 * height on one toolbar row" is pinned here as "same geometry classes". The
 * rendered result is measured in a real browser on the gallery.
 */
function boxClasses(node: Element): Set<string> {
  return new Set(
    [...node.classList].filter((token) =>
      /(^|:)(h-|w-|size-|p[xlrty]?-|gap-|rounded-|text-\[length:)/.test(token),
    ),
  );
}

function press(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("Toggle", () => {
  it("reports the state the caller should move to", () => {
    const onPressedChange = rs.fn();
    const { rerender } = render(
      <Toggle pressed={false} onPressedChange={onPressedChange}>
        Auto-start
      </Toggle>,
    );

    press("Auto-start");
    expect(onPressedChange).toHaveBeenLastCalledWith(true);

    rerender(
      <Toggle pressed onPressedChange={onPressedChange}>
        Auto-start
      </Toggle>,
    );
    press("Auto-start");
    expect(onPressedChange).toHaveBeenLastCalledWith(false);
  });

  it("announces the pressed state to assistive tech", () => {
    const { rerender } = render(
      <Toggle pressed={false} onPressedChange={() => {}}>
        Auto-start
      </Toggle>,
    );
    expect(screen.getByRole("button", { pressed: false, name: "Auto-start" })).toBeDefined();

    rerender(
      <Toggle pressed onPressedChange={() => {}}>
        Auto-start
      </Toggle>,
    );
    expect(screen.getByRole("button", { pressed: true, name: "Auto-start" })).toBeDefined();
  });

  it("stays on the caller-supplied state until the caller changes it", () => {
    render(
      <Toggle pressed={false} onPressedChange={() => {}}>
        Auto-start
      </Toggle>,
    );

    // Controlled-only: clicking does not flip the control on its own, so a
    // caller that rejects the change can't end up showing a state the app is
    // not in.
    press("Auto-start");
    expect(screen.getByRole("button", { name: "Auto-start" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("tracks the state a caller drives from the callback", () => {
    function Toolbar() {
      const [on, setOn] = useState(false);
      return (
        <Toggle pressed={on} onPressedChange={setOn}>
          Auto-start
        </Toggle>
      );
    }
    render(<Toolbar />);
    const toggle = screen.getByRole("button", { name: "Auto-start" });

    press("Auto-start");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    press("Auto-start");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("does not report a change while disabled", () => {
    const onPressedChange = rs.fn();
    render(
      <Toggle pressed={false} onPressedChange={onPressedChange} disabled>
        Auto-start
      </Toggle>,
    );

    press("Auto-start");

    expect(onPressedChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Auto-start" })).toHaveProperty("disabled", true);
  });

  it("keeps aria-pressed matching `pressed` even when a caller tries to set it", () => {
    // The props type refuses `aria-pressed`; this pins the runtime half, so an
    // untyped call site can't put the accessible state and the paint out of sync.
    const rogue = { "aria-pressed": false } as unknown as Partial<ToggleProps>;
    render(
      <Toggle pressed onPressedChange={() => {}} {...rogue}>
        Auto-start
      </Toggle>,
    );

    expect(screen.getByRole("button", { name: "Auto-start" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("never submits the form it sits in", () => {
    const onSubmit = rs.fn((event: FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Toggle pressed={false} onPressedChange={() => {}}>
          Auto-start
        </Toggle>
      </form>,
    );

    press("Auto-start");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(SIZES)("shares Button's box at size %s, in both states", (size) => {
    const { unmount } = render(
      <>
        <Button variant="ghost" size={size}>
          Save
        </Button>
        <Toggle pressed={false} onPressedChange={() => {}} size={size}>
          Off
        </Toggle>
        <Toggle pressed onPressedChange={() => {}} size={size} variant="outline">
          On
        </Toggle>
      </>,
    );

    const [button, off, on] = screen.getAllByRole("button") as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    // A pressed toggle changes paint, never geometry — otherwise a toolbar
    // reflows the moment one of its controls is switched on.
    expect(boxClasses(off)).toEqual(boxClasses(button));
    expect(boxClasses(on)).toEqual(boxClasses(button));

    unmount();
  });

  it("paints the pressed state as the highlight, not as the hover fill", () => {
    const { rerender } = render(
      <Toggle pressed={false} onPressedChange={() => {}}>
        Auto-start
      </Toggle>,
    );
    const toggle = screen.getByRole("button", { name: "Auto-start" });
    expect([...toggle.classList]).toContain("hover:bg-muted");
    expect([...toggle.classList].some((token) => token.startsWith("bg-primary"))).toBe(false);

    rerender(
      <Toggle pressed onPressedChange={() => {}}>
        Auto-start
      </Toggle>,
    );
    expect([...toggle.classList]).toContain("bg-primary/15");
    // The resting hover fill must lose the merge in every mode, or a hovered
    // pressed toggle drops back to looking unpressed.
    expect([...toggle.classList]).not.toContain("hover:bg-muted");
    expect([...toggle.classList]).not.toContain("dark:hover:bg-muted/50");
  });

  it("keeps the outline variant's hairline when it is pressed", () => {
    render(
      <Toggle pressed onPressedChange={() => {}} variant="outline">
        Auto-start
      </Toggle>,
    );

    expect([...screen.getByRole("button").classList]).toContain("border-border");
  });

  it("lets a caller's own fill win over the pressed treatment", () => {
    render(
      <Toggle pressed onPressedChange={() => {}} className="bg-success-bg">
        Auto-start
      </Toggle>,
    );
    const cls = [...screen.getByRole("button").classList];

    expect(cls).toContain("bg-success-bg");
    expect(cls).not.toContain("bg-primary/15");
  });

  it("renders inside the app's shadow root, under the theme scope", () => {
    const { appBody, mountRoot } = mountShadowApp();
    appBody.classList.add("dark");

    render(<Toggle pressed onPressedChange={() => {}} />, { container: mountRoot });

    // An app's compiled CSS lives in its shadow root, and the theme classes sit
    // on the app <body> — anything rendered outside that would paint unstyled.
    const toggle = mountRoot.querySelector('[data-slot="toggle"]');
    expect(toggle).not.toBeNull();
    expect(appBody.contains(toggle)).toBe(true);
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });
});
