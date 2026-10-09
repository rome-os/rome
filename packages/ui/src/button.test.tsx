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
