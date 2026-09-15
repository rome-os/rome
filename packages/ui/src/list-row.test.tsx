import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { List, ListRow, ListRowContent, ListRowDescription, ListRowTitle } from "./list-row.js";

afterEach(cleanup);

const SIZES = ["sm", "md"] as const;

function row(): HTMLElement {
  return screen.getByTestId("row");
}

/**
 * `interactive` is only accepted alongside `asChild`, so the paint it turns on
 * always sits on something that can take focus and answer a key.
 */
function InteractiveRow({ selected = false }: { selected?: boolean }) {
  return (
    <ListRow asChild interactive selected={selected}>
      <button type="button" data-testid="row" />
    </ListRow>
  );
}

describe("ListRow", () => {
  describe.each(SIZES)("at %s", (size) => {
    it("reads its floor and both insets off the row scale", () => {
      render(<ListRow size={size} data-testid="row" />);

      const cls = [...row().classList];
      expect(cls).toContain(`min-h-[var(--row-h-${size})]`);
      expect(cls).toContain(`px-[var(--row-px-${size})]`);
      expect(cls).toContain(`py-[var(--row-py-${size})]`);
      expect(row().getAttribute("data-size")).toBe(size);
    });
  });

  it("defaults to the md step", () => {
    render(<ListRow data-testid="row" />);

    expect([...row().classList]).toContain("min-h-[var(--row-h-md)]");
  });

  it("reads no other role's scale", () => {
    render(<InteractiveRow selected />);

    // The row is the box around a control, not a control: a row on the
    // control scale would be as tall as the button inside it and no taller.
    expect(row().className).not.toMatch(/--control-|--badge-|--field-/);
  });

  it("carries no margin and no fixed height", () => {
    render(<ListRow data-testid="row" />);

    const cls = [...row().classList];
    expect(cls.some((token) => /^-?m[trblxy]?-/.test(token))).toBe(false);
    // A floor, not a lock: a two-line row grows past the step.
    expect(cls.some((token) => /^h-/.test(token))).toBe(false);
  });

  it("paints hover and an inset focus edge only when interactive", () => {
    const { rerender } = render(<ListRow data-testid="row" />);
    let cls = [...row().classList];
    expect(cls.some((token) => token.startsWith("hover:"))).toBe(false);
    expect(cls.some((token) => token.startsWith("focus-visible:"))).toBe(false);

    rerender(<InteractiveRow />);
    cls = [...row().classList];
    expect(cls).toContain("hover:bg-surface-hover");
    expect(cls).toContain("outline-1");
    expect(cls).toContain("outline-transparent");
    expect(cls).toContain("focus-visible:outline-solid");
    expect(cls).toContain("focus-visible:outline-ring/50");
    // Inset: a row is full-bleed in a clipped list, so an edge outside the box
    // is cut away on both sides.
    expect(cls).toContain("-outline-offset-1");
  });

  it("marks and paints the selected row, and its hover fill wins", () => {
    render(<InteractiveRow selected />);

    const cls = [...row().classList];
    expect(row().getAttribute("data-selected")).toBe("true");
    expect(cls).toContain("bg-primary/10");
    expect(cls).toContain("hover:bg-primary/15");
    expect(cls).not.toContain("hover:bg-surface-hover");
  });

  // Hover answers a pointer that can act on the row. A row nothing can do
  // anything with still marks that it is the selected one.
  it("gives a selected row that is not interactive the fill without the hover", () => {
    render(<ListRow data-testid="row" selected />);

    const cls = [...row().classList];
    expect(row().getAttribute("data-selected")).toBe("true");
    expect(cls).toContain("bg-primary/10");
    expect(cls.some((token) => token.startsWith("hover:"))).toBe(false);
  });

  it("leaves an unselected row unmarked", () => {
    render(<ListRow data-testid="row" />);

    expect(row().hasAttribute("data-selected")).toBe(false);
  });

  // A row that is a link for some records and plain text for others decides at
  // render time, so the flag has to be a `boolean` and not the literal `true`.
  it("takes interactivity from a value the caller computes", () => {
    function Row({ open }: { open: boolean }) {
      return (
        <ListRow asChild interactive={open}>
          <button type="button" data-testid="row" />
        </ListRow>
      );
    }
    const { rerender } = render(<Row open={false} />);
    expect([...row().classList]).not.toContain("cursor-pointer");

    rerender(<Row open />);
    expect([...row().classList]).toContain("cursor-pointer");
  });

  // `@ts-expect-error` is the assertion: `pnpm typecheck` covers this file, so
  // the line fails the build the day the paint is accepted on a bare `div`.
  it("does not accept interaction paint on a row that takes no focus", () => {
    // @ts-expect-error `interactive` needs `asChild` with a focusable child
    render(<ListRow interactive data-testid="row" />);

    expect(row()).not.toBeNull();
  });

  it("renders the child element as the row with asChild", () => {
    const onClick = rs.fn();
    render(
      <ListRow asChild interactive size="sm">
        <button type="button" onClick={onClick}>
          Open
        </button>
      </ListRow>,
    );

    const button = screen.getByRole("button", { name: "Open" });
    expect(button.getAttribute("data-slot")).toBe("list-row");
    expect([...button.classList]).toContain("min-h-[var(--row-h-sm)]");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("lets a caller's layout and inset win", () => {
    render(<ListRow data-testid="row" className="grid grid-cols-2 px-0" />);

    const cls = [...row().classList];
    expect(cls).toContain("grid");
    expect(cls).not.toContain("flex");
    expect(cls).toContain("px-0");
    expect(cls).not.toContain("px-[var(--row-px-md)]");
  });

  it("draws no border of its own", () => {
    render(<InteractiveRow selected />);

    // The separator belongs to List, so a row is the same box first and last.
    expect([...row().classList].some((token) => /^border/.test(token))).toBe(false);
  });
});

describe("List", () => {
  // A run history or a directory is a list in the document too, not only in
  // the layout, and the separator has to stay the section's either way.
  it("renders the child element as the list with asChild", () => {
    render(
      <List asChild data-testid="list">
        <ul>
          <ListRow asChild>
            <li>One</li>
          </ListRow>
        </ul>
      </List>,
    );

    const list = screen.getByTestId("list");
    expect(list.tagName).toBe("UL");
    expect(list.getAttribute("data-slot")).toBe("list");
    expect([...list.classList]).toContain("divide-y");
    expect(list.firstElementChild?.tagName).toBe("LI");
    expect(list.firstElementChild?.getAttribute("data-slot")).toBe("list-row");
  });

  it("separates its rows with a hairline", () => {
    render(
      <List data-testid="list">
        <ListRow>One</ListRow>
        <ListRow>Two</ListRow>
      </List>,
    );

    const cls = [...screen.getByTestId("list").classList];
    expect(cls).toContain("divide-y");
    expect(cls).toContain("divide-border-subtle");
  });
});

describe("the row's parts", () => {
  it("take the roster's two text roles and the remaining width", () => {
    render(
      <ListRow>
        <ListRowContent data-testid="content">
          <ListRowTitle data-testid="title">Alice</ListRowTitle>
          <ListRowDescription data-testid="description">@alice</ListRowDescription>
        </ListRowContent>
      </ListRow>,
    );

    const content = [...screen.getByTestId("content").classList];
    expect(content).toContain("min-w-0");
    expect(content).toContain("flex-1");
    expect([...screen.getByTestId("title").classList]).toContain("text-ui");
    const description = [...screen.getByTestId("description").classList];
    expect(description).toContain("text-aux");
    expect(description).toContain("text-muted-foreground");
  });
});
