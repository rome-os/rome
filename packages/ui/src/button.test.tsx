import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ArrowRight, Plus } from "lucide-react";

import { Button } from "./button.js";

afterEach(cleanup);

/** A keyboard hint: a component element that carries content, unlike a glyph. */
function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}

function edges(node: HTMLElement) {
  return {
    start: node.hasAttribute("data-icon-start"),
    end: node.hasAttribute("data-icon-end"),
  };
}

describe("Button glyph edges", () => {
  it("marks a leading glyph beside a label", () => {
    render(
      <Button>
        <Plus />
        Add app
      </Button>,
    );
    expect(edges(screen.getByRole("button"))).toEqual({ start: true, end: false });
  });

  it("marks a trailing glyph beside a label", () => {
    render(
      <Button>
        Continue
        <ArrowRight />
      </Button>,
    );
    expect(edges(screen.getByRole("button"))).toEqual({ start: false, end: true });
  });

  it("marks nothing on a lone glyph or a bare label", () => {
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
