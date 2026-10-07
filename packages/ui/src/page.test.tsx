import { createRef, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  Measure,
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeaderNav,
  PageHeading,
  PageNav,
  PageNavLink,
  PageTitle,
  PageTopBarOutlet,
  PageTopBarProvider,
  Section,
  SectionActions,
  SectionDescription,
  SectionHeader,
  SectionHeading,
  SectionTitle,
} from "./page.js";

afterEach(cleanup);

function ExamplePage() {
  return (
    <Page data-testid="page">
      <PageHeader>
        <PageHeaderNav>Apps</PageHeaderNav>
        <PageHeading>
          <PageTitle>Routines</PageTitle>
          <PageDescription>Everything Rome runs on a schedule.</PageDescription>
        </PageHeading>
        <PageActions>
          <button type="button">New routine</button>
        </PageActions>
      </PageHeader>
      <Section>
        <SectionHeader>
          <SectionHeading>
            <SectionTitle>Daily</SectionTitle>
            <SectionDescription>Runs every morning.</SectionDescription>
          </SectionHeading>
          <SectionActions>
            <button type="button">Pause</button>
          </SectionActions>
        </SectionHeader>
        <Measure data-testid="measure">Body</Measure>
      </Section>
    </Page>
  );
}

describe("Page", () => {
  it("owns the shared padding and the 24px rhythm, and centers nothing", () => {
    render(<ExamplePage />);

    const page = screen.getByTestId("page");
    expect([...page.classList]).toEqual(
      expect.arrayContaining(["w-full", "p-4", "sm:p-6", "lg:p-8", "flex", "flex-col", "gap-6"]),
    );
    expect([...page.classList]).not.toContain("mx-auto");
  });

  it("renders no main landmark, which the shell owns", () => {
    const { container } = render(<ExamplePage />);

    expect(container.querySelector("main")).toBeNull();
  });

  it("carries one title as an h1 and each section title as an h2", () => {
    render(<ExamplePage />);

    const title = screen.getByRole("heading", { name: "Routines" });
    expect(title.tagName).toBe("H1");
    expect([...title.classList]).toContain("text-title");

    const sectionTitle = screen.getByRole("heading", { name: "Daily" });
    expect(sectionTitle.tagName).toBe("H2");
    expect([...sectionTitle.classList]).toContain("text-section");
  });

  it("places the header slots inside the header and the body straight under it", () => {
    const { container } = render(<ExamplePage />);

    const header = container.querySelector('[data-slot="page-header"]');
    expect(header?.tagName).toBe("HEADER");
    for (const slot of ["page-header-nav", "page-heading", "page-actions"]) {
      expect(header?.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }

    const section = container.querySelector('[data-slot="page"] > [data-slot="section"]');
    expect(section?.tagName).toBe("SECTION");
    expect(section?.querySelector('[data-slot="section-actions"]')).not.toBeNull();
  });

  it("meets the actions at the title's top edge by default, and at its bottom on request", () => {
    const { container: byDefault } = render(
      <PageHeader data-testid="start-header">
        <PageHeading>
          <PageTitle>Sessions</PageTitle>
        </PageHeading>
        <PageActions>
          <button type="button">Refresh</button>
        </PageActions>
      </PageHeader>,
    );
    const start = byDefault.querySelector('[data-slot="page-header"]');
    expect(start?.getAttribute("data-align")).toBe("start");
    expect([...(start?.classList ?? [])]).toContain("items-start");
    expect([...(start?.classList ?? [])]).not.toContain("items-end");

    // `end` is for the header whose actions are one control on the title's row:
    // the control's bottom edge rests on the title's line box.
    const { container: atEnd } = render(
      <PageHeader align="end">
        <PageHeading>
          <PageTitle>Sessions</PageTitle>
        </PageHeading>
        <PageActions>
          <button type="button">Overview</button>
        </PageActions>
      </PageHeader>,
    );
    const end = atEnd.querySelector('[data-slot="page-header"]');
    expect(end?.getAttribute("data-align")).toBe("end");
    expect([...(end?.classList ?? [])]).toContain("items-end");
    expect([...(end?.classList ?? [])]).not.toContain("items-start");
  });

  it("caps a measure without the caller writing a width", () => {
    render(<ExamplePage />);

    expect([...screen.getByTestId("measure").classList]).toContain("max-w-2xl");
  });
});

function ExampleNav() {
  return (
    <PageNav aria-label="Settings" data-testid="nav">
      <PageNavLink asChild active>
        <a href="/settings/appearance">Appearance</a>
      </PageNavLink>
      <PageNavLink asChild>
        <a href="/settings/connections">Connections</a>
      </PageNavLink>
    </PageNav>
  );
}

describe("PageNav", () => {
  it("names the strip and renders it as a list of links, not a tablist", () => {
    const { container } = render(<ExampleNav />);

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav.tagName).toBe("NAV");
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="page-nav-item"]')).toHaveLength(2);
    expect(nav.querySelector("ul > li > a")).not.toBeNull();
  });

  it("marks the current entry for a reader as well as for the eye", () => {
    render(<ExampleNav />);

    const current = screen.getByRole("link", { name: "Appearance" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect([...current.classList]).toContain("after:opacity-100");

    const other = screen.getByRole("link", { name: "Connections" });
    expect(other.getAttribute("aria-current")).toBeNull();
    expect([...other.classList]).not.toContain("after:opacity-100");
  });

  it("scrolls the row sideways rather than wrapping it onto a second line", () => {
    const { container } = render(<ExampleNav />);

    const list = container.querySelector('[data-slot="page-nav"] > ul');
    expect([...(list?.classList ?? [])]).toEqual(
      expect.arrayContaining(["flex", "overflow-x-auto", "border-b"]),
    );
    expect([...(list?.classList ?? [])]).not.toContain("flex-wrap");
  });
});

function InShell({ children }: { children?: ReactNode }) {
  return (
    <PageTopBarProvider>
      <header data-testid="bar">
        <PageTopBarOutlet fallback={<span>Rome</span>} />
      </header>
      {children}
    </PageTopBarProvider>
  );
}

function mockViewport(initialPhone: boolean) {
  let phone = initialPhone;
  const listeners = new Set<() => void>();
  rs.spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        get matches() {
          return phone;
        },
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
  return {
    resize(nextPhone: boolean) {
      phone = nextPhone;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

function bottomAt(el: Element, bottom: () => number) {
  rs.spyOn(el, "getBoundingClientRect").mockImplementation(
    () => ({ bottom: bottom(), top: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect,
  );
}

describe("PageTopBar", () => {
  afterEach(() => {
    rs.restoreAllMocks();
  });

  it("shows the fallback while no header holds the bar", () => {
    mockViewport(true);
    render(<InShell />);

    expect(screen.getByTestId("bar").textContent).toBe("Rome");
  });

  it("renders the back link and a lone action in the bar on a phone, and keeps the h1 in the page", () => {
    mockViewport(true);
    render(
      <InShell>
        <ExamplePage />
      </InShell>,
    );

    const bar = screen.getByTestId("bar");
    expect(bar.textContent).not.toContain("Rome");
    expect(bar.textContent).toContain("Apps");
    expect(bar.querySelector("button")?.textContent).toBe("New routine");

    const page = screen.getByTestId("page");
    expect(page.querySelector('[data-slot="page-header-nav"]')).toBeNull();
    expect(page.querySelector('[data-slot="page-actions"]')).toBeNull();
    expect(screen.getAllByRole("button", { name: "New routine" })).toHaveLength(1);

    // The bar repeats the title for the eye only, so a reader still meets one h1.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const title = bar.querySelector('[data-slot="page-top-bar-title"]');
    expect(title?.textContent).toBe("Routines");
    expect(title?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps every part in the page at md and wider", () => {
    mockViewport(false);
    render(
      <InShell>
        <ExamplePage />
      </InShell>,
    );

    const bar = screen.getByTestId("bar");
    expect(bar.querySelector("button")).toBeNull();
    expect(bar.querySelector('[data-slot="page-top-bar-title"]')).toBeNull();
    const page = screen.getByTestId("page");
    expect(page.querySelector('[data-slot="page-header-nav"]')?.textContent).toBe("Apps");
    expect(page.querySelector('[data-slot="page-actions"] button')?.textContent).toBe(
      "New routine",
    );
  });

  it("moves a lone action between the page and the bar when the viewport crosses md", () => {
    const viewport = mockViewport(false);
    render(
      <InShell>
        <PageHeader>
          <PageHeading>
            <PageTitle>Keys</PageTitle>
          </PageHeading>
          <PageActions>
            <button type="button">New key</button>
          </PageActions>
        </PageHeader>
      </InShell>,
    );

    expect(screen.getByTestId("bar").querySelector("button")).toBeNull();

    viewport.resize(true);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("bar").querySelector("button")).not.toBeNull();

    viewport.resize(false);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByTestId("bar").querySelector("button")).toBeNull();
  });

  it("keeps two or more actions in the page, since the bar holds one", () => {
    mockViewport(true);
    render(
      <InShell>
        <PageHeader>
          <PageHeading>
            <PageTitle>Apps</PageTitle>
          </PageHeading>
          <PageActions>
            <button type="button">Import</button>
            <button type="button">Install</button>
          </PageActions>
        </PageHeader>
      </InShell>,
    );

    expect(screen.getByTestId("bar").querySelector("button")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("shows the bar's title once the h1's bottom edge passes the bar header's bottom", () => {
    mockViewport(true);
    let headingBottom = 120;
    let barBottom = 56;
    rs.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      // Runs the frame at once. Returning 0 marks no frame pending, as the
      // hook's own reset does once a real frame has run.
      callback(0);
      return 0;
    });
    rs.spyOn(HTMLHeadingElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ bottom: headingBottom }) as DOMRect,
    );

    render(
      <InShell>
        <ExamplePage />
      </InShell>,
    );
    bottomAt(screen.getByTestId("bar"), () => barBottom);
    const title = () => screen.getByTestId("bar").querySelector('[data-slot="page-top-bar-title"]');

    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(title()?.hasAttribute("data-shown")).toBe(false);

    // Covered by the header itself, not by some inner box of it.
    headingBottom = 56;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(title()?.hasAttribute("data-shown")).toBe(true);

    // A taller bar moves the boundary without a remount.
    headingBottom = 70;
    barBottom = 80;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(title()?.hasAttribute("data-shown")).toBe(true);
  });

  it("hands the caller's ref the h1 and still shows the bar's title on scroll", () => {
    mockViewport(true);
    let headingBottom = 120;
    rs.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    rs.spyOn(HTMLHeadingElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ bottom: headingBottom }) as DOMRect,
    );
    const ref = createRef<HTMLHeadingElement>();
    render(
      <InShell>
        <PageHeader>
          <PageHeading>
            <PageTitle ref={ref}>Keys</PageTitle>
          </PageHeading>
        </PageHeader>
      </InShell>,
    );
    bottomAt(screen.getByTestId("bar"), () => 56);

    expect(ref.current).toBe(screen.getByRole("heading", { level: 1 }));
    headingBottom = 40;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    const title = screen.getByTestId("bar").querySelector('[data-slot="page-top-bar-title"]');
    expect(title?.hasAttribute("data-shown")).toBe(true);
  });

  for (const [where, phone, wrap] of [
    ["outside a provider", true, (node: ReactNode) => node],
    ["at md and wider", false, (node: ReactNode) => <InShell>{node}</InShell>],
    ["in the bar", true, (node: ReactNode) => <InShell>{node}</InShell>],
  ] as const) {
    it(`gives the caller's ref and handlers the wrapper ${where}`, () => {
      mockViewport(phone);
      const navRef = createRef<HTMLDivElement>();
      const actionsRef = createRef<HTMLDivElement>();
      const onNavClick = rs.fn();
      const onActionsClick = rs.fn();
      render(
        wrap(
          <PageHeader>
            <PageHeaderNav ref={navRef} onClick={onNavClick}>
              <a href="/back">Back</a>
            </PageHeaderNav>
            <PageHeading>
              <PageTitle>Keys</PageTitle>
            </PageHeading>
            <PageActions ref={actionsRef} onClick={onActionsClick}>
              <button type="button">Add</button>
            </PageActions>
          </PageHeader>,
        ),
      );

      expect(navRef.current?.dataset.slot).toBe("page-header-nav");
      expect(actionsRef.current?.dataset.slot).toBe("page-actions");
      fireEvent.click(screen.getByRole("link", { name: "Back" }));
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      expect(onNavClick).toHaveBeenCalledTimes(1);
      expect(onActionsClick).toHaveBeenCalledTimes(1);
    });
  }

  it("calls a callback ref's own cleanup on unmount, as a plain h1 would", () => {
    mockViewport(true);
    const cleanup = rs.fn();
    const ref = rs.fn(() => cleanup);
    const { unmount } = render(
      <InShell>
        <PageHeader>
          <PageHeading>
            <PageTitle ref={ref}>Keys</PageTitle>
          </PageHeading>
        </PageHeader>
      </InShell>,
    );
    unmount();

    expect(ref).toHaveBeenCalledTimes(1);
    expect(ref).toHaveBeenCalledWith(expect.any(HTMLHeadingElement));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("gives the bar back to the fallback when the header unmounts", () => {
    mockViewport(true);
    const { rerender } = render(
      <InShell>
        <ExamplePage />
      </InShell>,
    );
    for (let cycle = 0; cycle < 3; cycle += 1) {
      rerender(<InShell />);
      rerender(
        <InShell>
          <ExamplePage />
        </InShell>,
      );
    }
    rerender(<InShell />);

    const bar = screen.getByTestId("bar");
    expect(bar.textContent).toBe("Rome");
    // The nav, title and action hosts hold nothing a header left behind.
    const hosts = bar.querySelectorAll('[data-slot="page-top-bar"] > div');
    expect(hosts).toHaveLength(3);
    for (const host of hosts) expect(host.childNodes).toHaveLength(0);
  });

  it("renders every part in the page alone outside a provider", () => {
    mockViewport(true);
    render(<ExamplePage />);

    expect(
      screen.getByTestId("page").querySelector('[data-slot="page-header-nav"]'),
    ).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "New routine" })).toHaveLength(1);
  });
});

describe("Page on a server", () => {
  it("renders the header inline without a top-bar provider", () => {
    const markup = renderToString(<ExamplePage />);

    expect(markup).toContain('data-slot="page-header-nav"');
    expect(markup).toContain(">Apps<");
    expect(markup).toContain(">New routine</button>");
  });
});
