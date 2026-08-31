import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Badge, type BadgeProps } from "./badge.js";

afterEach(cleanup);

const VARIANTS = [
  "default",
  "info",
  "success",
  "warning",
  "brand",
  "destructive",
  "muted",
  "outline",
] as const satisfies readonly NonNullable<BadgeProps["variant"]>[];

/**
 * The class tokens that decide the badge's box, i.e. everything that isn't
 * paint: `border` (the width) counts, `border-border` (the color) doesn't;
 * `text-[length:…]` counts, `text-info-fg` doesn't.
 *
 * jsdom does no layout — `offsetHeight` is 0 for every element — so "same box"
 * is pinned here as "same geometry classes". The rendered result is checked in
 * a real browser on the style-guide page.
 */
function boxClasses(node: Element): string[] {
  return [...node.classList].filter(
    (token) => !/^(bg-|border-(?!\d)|text-(?!\[length:))/.test(token),
  );
}

describe("Badge", () => {
  it("renders a span carrying the badge geometry by default", () => {
    render(<Badge>ready</Badge>);
    const badge = screen.getByText("ready");

    expect(badge.tagName).toBe("SPAN");
    expect([...badge.classList]).toContain("text-badge");
    expect(boxClasses(badge)).toContain("h-[var(--badge-h)]");
  });

  it("becomes the caller's own element under asChild — a badge that navigates is one anchor", () => {
    const { container } = render(
      <Badge asChild variant="outline">
        <a href="https://example.test/pull/1234">#1234</a>
      </Badge>,
    );

    const link = screen.getByRole("link", { name: "#1234" });
    expect(link.getAttribute("href")).toBe("https://example.test/pull/1234");
    // One element, not an anchor nested in a span.
    expect(container.querySelector("span")).toBeNull();
    expect(container.firstElementChild).toBe(link);
    expect(boxClasses(link)).toContain("h-[var(--badge-h)]");
    expect([...link.classList]).toContain("border-border");
  });

  it("keeps the child's own classes when it takes over the element", () => {
    render(
      <Badge asChild>
        <a href="#" className="underline">
          #1234
        </a>
      </Badge>,
    );
    const cls = [...screen.getByRole("link").classList];

    expect(cls).toContain("underline");
    expect(cls).toContain("h-[var(--badge-h)]");
  });

  it("forwards the ref to whichever element is rendered", () => {
    const span = createRef<HTMLElement>();
    const anchor = createRef<HTMLElement>();

    render(
      <>
        <Badge ref={span}>ready</Badge>
        <Badge asChild ref={anchor}>
          <a href="#">#1234</a>
        </Badge>
      </>,
    );

    expect(span.current).toBe(screen.getByText("ready"));
    expect(anchor.current).toBe(screen.getByRole("link"));
  });

  it("draws outline as a bordered chip with nothing filled behind it", () => {
    render(<Badge variant="outline">draft</Badge>);
    const cls = [...screen.getByText("draft").classList];

    expect(cls).toContain("border-border");
    expect(cls).toContain("text-foreground");
    expect(cls.some((token) => token.startsWith("bg-"))).toBe(false);
  });

  it("sizes a glyph the caller never sized", () => {
    render(
      <Badge>
        <svg data-testid="glyph" />
        On
      </Badge>,
    );

    expect([...screen.getByText("On").classList]).toContain("[&_svg:not([class*='size-'])]:size-3");
    expect(screen.getByTestId("glyph").getAttribute("class")).toBeNull();
  });

  it("stands aside for a glyph the caller did size", () => {
    render(
      <Badge>
        <svg data-testid="glyph" className="size-4" />
        On
      </Badge>,
    );

    // The rule stays on the badge either way — it is the `:not()` in its
    // selector that stops matching, not `cn` dropping a class, because the two
    // sit on different elements and tailwind-merge never compares them.
    expect([...screen.getByText("On").classList]).toContain("[&_svg:not([class*='size-'])]:size-3");
    expect([...screen.getByTestId("glyph").classList]).toContain("size-4");
  });

  it("keeps the glyph rules when the caller resizes the badge itself", () => {
    render(<Badge className="h-6">12</Badge>);
    const cls = [...screen.getByText("12").classList];

    // `h-6` collides with the badge's own height and wins; the glyph rules
    // share no group with it and must survive that merge.
    expect(cls).toContain("h-6");
    expect(cls).toContain("[&_svg:not([class*='size-'])]:size-3");
    expect(cls).toContain("[&_svg]:shrink-0");
  });

  it("gives every variant the same box — a variant changes paint, never geometry", () => {
    for (const shape of ["pill", "square"] as const) {
      const boxes = VARIANTS.map((variant) => {
        const { unmount } = render(
          <Badge variant={variant} shape={shape}>
            {variant}
          </Badge>,
        );
        const box = boxClasses(screen.getByText(variant));
        unmount();
        return box.join(" ");
      });

      // Including the border: it is on every variant, so switching to `outline`
      // paints a border that was already occupying the box rather than adding
      // one and shoving the badge's neighbours over.
      expect(boxes[0]?.split(" ")).toContain("border");
      expect(new Set(boxes).size).toBe(1);
    }
  });
});
