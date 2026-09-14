// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { PageHeader } from "./PageShell";

afterEach(cleanup);

describe("PageHeader", () => {
  it("gives the page one heading, and the title is all of it", () => {
    render(
      <PageHeader
        title="Routines"
        titleAside={<span>Disabled</span>}
        description="3 enabled"
        leading={<span data-testid="mark" />}
        actions={<button type="button">New</button>}
      />,
    );

    const heading = screen.getByRole("heading", { level: 1 });
    // The name a screen reader announces is the page's, not the page's plus
    // whatever state happened to sit beside it.
    expect(heading.textContent).toBe("Routines");
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("places the aside, the caption, the mark, and the actions outside the heading", () => {
    render(
      <PageHeader
        title="Routines"
        titleAside={<span data-testid="aside">Disabled</span>}
        description={<span data-testid="caption">3 enabled</span>}
        leading={<span data-testid="mark" />}
        actions={<button type="button">New</button>}
      />,
    );

    const heading = screen.getByRole("heading", { level: 1 });
    for (const id of ["aside", "caption", "mark"]) {
      expect(heading.contains(screen.getByTestId(id))).toBe(false);
    }
    expect(heading.contains(screen.getByRole("button", { name: "New" }))).toBe(false);
  });

  it("renders no caption row and no action row when neither is given", () => {
    const { container } = render(<PageHeader title="Settings" />);

    const header = container.querySelector('[data-slot="page-header"]');
    expect(header).not.toBeNull();
    expect(header?.textContent).toBe("Settings");
  });

  // An empty string is still a caption the layout has to hold. `null` and
  // `undefined` are the absent ones.
  it("keeps a caption that renders nothing rather than collapsing the row", () => {
    const { container } = render(<PageHeader title="Settings" description="" />);

    expect(container.querySelectorAll(".mt-1")).toHaveLength(1);
  });

  it("lets the page add to the header's own layout classes", () => {
    const { container } = render(<PageHeader title="Settings" className="pt-2" />);

    const cls = [...(container.querySelector('[data-slot="page-header"]')?.classList ?? [])];
    expect(cls).toContain("pt-2");
    expect(cls).toContain("flex");
  });
});
