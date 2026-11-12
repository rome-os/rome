// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ComposioServiceBadge } from "./composio-glyphs";

afterEach(cleanup);

describe("ComposioServiceBadge", () => {
  // A hidden grid card and the open pane can show the same logo at once, and
  // `url(#…)` resolves to the first element with that id in the page.
  it.each([
    "calendar",
    "sheets",
    "slides",
  ])("gives each copy of the %s logo its own SVG ids", (glyph) => {
    const { container } = render(
      <>
        <ComposioServiceBadge glyph={glyph} />
        <ComposioServiceBadge glyph={glyph} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of container.querySelectorAll("svg")) {
      const refs = [...svg.outerHTML.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
      for (const ref of refs) expect(svg.querySelector(`[id="${ref}"]`)).not.toBeNull();
    }
  });
});
