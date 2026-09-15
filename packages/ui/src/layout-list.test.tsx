import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ListCollection, ListFooter, ListGrid, ListLayout, ListToolbar } from "./layout-list.js";
import { PageHeader, PageHeading, PageTitle } from "./page.js";

afterEach(cleanup);

function ExampleList() {
  return (
    <ListLayout data-testid="layout">
      <PageHeader>
        <PageHeading>
          <PageTitle>Apps</PageTitle>
        </PageHeading>
      </PageHeader>
      <ListToolbar aria-label="Filter apps">
        <input aria-label="Search apps" />
      </ListToolbar>
      <ListCollection>
        <ListGrid>
          <article>Inbox</article>
        </ListGrid>
      </ListCollection>
      <ListFooter>1 of 40</ListFooter>
    </ListLayout>
  );
}

describe("ListLayout", () => {
  it("renders on the shared page frame with no main landmark", () => {
    const { container } = render(<ExampleList />);

    expect([...screen.getByTestId("layout").classList]).toEqual(
      expect.arrayContaining(["w-full", "p-4", "gap-6"]),
    );
    expect(container.querySelector("main")).toBeNull();
  });

  it("holds the toolbar, the collection, and the footer as its own slots", () => {
    const { container } = render(<ExampleList />);

    const layout = container.querySelector('[data-slot="list-layout"]');
    expect([...(layout?.children ?? [])].map((child) => child.getAttribute("data-slot"))).toEqual([
      "page-header",
      "list-toolbar",
      "list-collection",
      "list-footer",
    ]);
  });

  it("gives the toolbar a named toolbar role, so its controls share one tab stop", () => {
    render(<ExampleList />);

    expect(screen.getByRole("toolbar", { name: "Filter apps" })).toBeDefined();
  });

  it("supplies the card grid's columns, so a call site writes none", () => {
    const { container } = render(<ExampleList />);

    const grid = container.querySelector('[data-slot="list-grid"]');
    expect([...(grid?.classList ?? [])]).toEqual(
      expect.arrayContaining(["grid", "grid-cols-1", "sm:grid-cols-2", "xl:grid-cols-3"]),
    );
  });
});
