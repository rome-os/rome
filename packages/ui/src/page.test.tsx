import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  Measure,
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderNav,
  PageHeading,
  PageTitle,
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
      <PageBody>
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
      </PageBody>
    </Page>
  );
}

describe("Page", () => {
  it("owns the shared page padding and centers nothing", () => {
    render(<ExamplePage />);

    const page = screen.getByTestId("page");
    expect([...page.classList]).toEqual(
      expect.arrayContaining(["w-full", "p-4", "sm:p-6", "lg:p-8"]),
    );
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

  it("places the header slots inside the header and the rest inside the body", () => {
    const { container } = render(<ExamplePage />);

    const header = container.querySelector('[data-slot="page-header"]');
    expect(header?.tagName).toBe("HEADER");
    for (const slot of ["page-header-nav", "page-heading", "page-actions"]) {
      expect(header?.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    }

    const section = container.querySelector('[data-slot="page-body"] [data-slot="section"]');
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
