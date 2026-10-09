import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ArrowRight, Plus } from "lucide-react";

import { Button } from "./button.js";
import { Toggle } from "./toggle.js";

afterEach(cleanup);

/** A keyboard hint: a component element that carries content, unlike a glyph. */
function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}

/** Which sides took the plain glyph-side trim class. */
function edges(node: HTMLElement) {
  const tokens = [...node.classList];
  return {
    start: tokens.some((token) => token.startsWith("pl-[var(--control-px-icon-")),
    end: tokens.some((token) => token.startsWith("pr-[var(--control-px-icon-")),
  };
}

describe("Button glyph edges", () => {
  it("trims a leading glyph beside a label", () => {
    render(
      <Button>
        <Plus />
        Add app
      </Button>,
    );
    expect(edges(screen.getByRole("button"))).toEqual({ start: true, end: false });
  });

  it("trims a trailing glyph beside a label", () => {
    render(
      <Button>
        Continue
        <ArrowRight />
      </Button>,
    );
    expect(edges(screen.getByRole("button"))).toEqual({ start: false, end: true });
  });

  it("trims nothing on a lone glyph or a bare label", () => {
    render(
      <>
        <Button aria-label="Add">
          <Plus />
        </Button>
        <Button>Save</Button>
      </>,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(edges(button)).toEqual({ start: false, end: false });
    }
  });

  it("reads a blank string beside a glyph as no label", () => {
    render(
      <Button aria-label="Add">
        <Plus />
        {""}
      </Button>,
    );
    expect(edges(screen.getByRole("button"))).toEqual({ start: false, end: false });
  });

  it("does not treat a trailing element with content as a glyph", () => {
    render(
      <Button>
        Search
        <Kbd>⌘K</Kbd>
      </Button>,
    );
    expect(edges(screen.getByRole("button"))).toEqual({ start: false, end: false });
  });

  it("leaves asChild content to name its own glyph side", () => {
    render(
      <Button asChild>
        <a href="/apps">
          <Plus />
          Apps
        </a>
      </Button>,
    );
    expect(edges(screen.getByRole("link"))).toEqual({ start: false, end: false });
  });
});

describe("Button glyph inset", () => {
  it("trims the glyph side on a centred step", () => {
    render(
      <Button size="md">
        <Plus />
        Add app
      </Button>,
    );
    expect(screen.getByRole("button").className).toContain("pl-[var(--control-px-icon-md)]");
  });

  it("reads a glyph through a fragment", () => {
    render(
      <Button size="sm">
        <>
          <Plus />
          Add app
        </>
      </Button>,
    );
    expect(screen.getByRole("button").className).toContain("pl-[var(--control-px-icon-sm)]");
  });

  it("lets a caller's px win on the glyph side", () => {
    render(
      <Button size="sm" className="px-2">
        View all
        <ArrowRight />
      </Button>,
    );
    const { classList } = screen.getByRole("button");
    expect(classList).toContain("px-2");
    expect(classList).not.toContain("pr-[var(--control-px-icon-sm)]");
  });

  it("lets a caller's px win over a marked glyph too", () => {
    render(
      <Button size="sm" className="px-2">
        <Plus data-icon="inline-start" />
        Add app
      </Button>,
    );
    const { className } = screen.getByRole("button");
    expect(className).toContain("px-2");
    expect(className).not.toContain("control-px-icon-sm");
  });

  it("keeps the marker trim for asChild content", () => {
    render(
      <Button asChild size="sm">
        <a href="/apps">
          <Plus data-icon="inline-start" />
          Apps
        </a>
      </Button>,
    );
    expect(screen.getByRole("link").className).toContain(
      "has-data-[icon=inline-start]:pl-[var(--control-px-icon-sm)]",
    );
  });

  it("leaves start-aligned buttons on their alignment inset", () => {
    render(
      <Button align="start">
        <Plus />
        Add app
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button.classList).not.toContain("pl-[var(--control-px-icon-md)]");
    expect(edges(button)).toEqual({ start: false, end: false });
  });
});

describe("Button glyph paths", () => {
  // The read path (`glyph-edge.ts`) and the marked path (the compound rows)
  // each carry the step-to-token table, so they are pinned to agree.
  it.each([
    "sm",
    "md",
    "default",
    "xs",
    "icon-md",
  ] as const)("trims the same token on both paths at size %s", (size) => {
    render(
      <>
        <Button size={size}>
          <Plus />
          Read
        </Button>
        <Button asChild size={size}>
          <a href="/marked">
            <Plus data-icon="inline-start" />
            Marked
          </a>
        </Button>
      </>,
    );
    const token = (className: string) =>
      className.match(/pl-\[var\((--control-px-icon-[a-z]+)\)\]/)?.[1] ?? null;
    expect(token(screen.getByRole("link").className)).toBe(
      token(screen.getByRole("button").className),
    );
  });
});

describe("Toggle glyph inset", () => {
  it("trims the glyph side the same way Button does", () => {
    render(
      <>
        <Button size="sm">
          <Plus />
          Bold
        </Button>
        <Toggle size="sm" pressed={false} onPressedChange={() => {}}>
          <Plus />
          Bold
        </Toggle>
      </>,
    );
    const [button, toggle] = screen.getAllByRole("button") as [HTMLElement, HTMLElement];
    expect(edges(toggle)).toEqual({ start: true, end: false });
    expect(edges(toggle)).toEqual(edges(button));
  });
});
