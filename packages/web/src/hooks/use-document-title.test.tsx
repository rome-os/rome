// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render } from "@testing-library/react";
import { useDocumentTitle } from "./use-document-title";

function Page({ title }: { title: string | readonly (string | null)[] | null }) {
  useDocumentTitle(title);
  return null;
}

function Layout({ title, children }: { title: string | null; children?: React.ReactNode }) {
  useDocumentTitle(title, "route");
  return <>{children}</>;
}

afterEach(() => {
  cleanup();
  document.title = "Rome";
});

describe("useDocumentTitle", () => {
  it("names the page it is mounted in", () => {
    render(<Page title="Alice" />);
    expect(document.title).toBe("Alice · Rome");
  });

  it("joins a list most-specific-first", () => {
    render(<Page title={["Connections", "Settings"]} />);
    expect(document.title).toBe("Connections · Settings · Rome");
  });

  // React runs a child's effect before its parent's, so a layout that assigned
  // document.title directly would win this race and erase the page's title.
  it("lets the page outrank the layout it renders inside", () => {
    render(
      <Layout title="Chat">
        <Page title="Trip planning" />
      </Layout>,
    );
    expect(document.title).toBe("Trip planning · Rome");
  });

  it("falls back to the layout's title while the page has no name yet", () => {
    const view = render(
      <Layout title="People">
        <Page title={null} />
      </Layout>,
    );
    expect(document.title).toBe("People · Rome");

    view.rerender(
      <Layout title="People">
        <Page title="Alice" />
      </Layout>,
    );
    expect(document.title).toBe("Alice · Rome");
  });

  it("returns the layout's title when the page unmounts", () => {
    const view = render(
      <Layout title="People">
        <Page title="Alice" />
      </Layout>,
    );
    expect(document.title).toBe("Alice · Rome");

    view.rerender(<Layout title="People" />);
    expect(document.title).toBe("People · Rome");
  });

  // A page mounted before its predecessor unmounts must keep the title it set.
  it("ignores a release from a page that no longer holds the slot", () => {
    const view = render(
      <>
        <Page title="Leaving" />
        <Page title="Arriving" />
      </>,
    );
    expect(document.title).toBe("Arriving · Rome");

    view.rerender(<Page title="Arriving" />);
    expect(document.title).toBe("Arriving · Rome");
  });

  it("holds no title for a list that names nothing", () => {
    render(<Page title={[null, "  "]} />);
    expect(document.title).toBe("Rome");
  });

  it("leaves the bare site name once nothing is mounted", () => {
    const view = render(<Page title="Alice" />);
    expect(document.title).toBe("Alice · Rome");
    view.unmount();
    expect(document.title).toBe("Rome");
  });

  it("follows a rename without remounting", () => {
    const view = render(<Page title="Untitled" />);
    view.rerender(<Page title="Trip planning" />);
    expect(document.title).toBe("Trip planning · Rome");
  });
});
