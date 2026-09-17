import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowIcon,
  FormRowLabel,
  FormRows,
} from "./layout-form.js";
import { Page, PageHeader, PageHeading, PageTitle } from "./page.js";

afterEach(cleanup);

function ExampleSettings() {
  return (
    <Page data-testid="page">
      <PageHeader>
        <PageHeading>
          <PageTitle>Settings</PageTitle>
        </PageHeading>
      </PageHeader>
      <FormRows data-testid="rows">
        <FormRow data-testid="row">
          <FormRowIcon data-testid="icon">
            <svg aria-hidden="true" />
          </FormRowIcon>
          <FormRowHeading data-testid="heading">
            <FormRowLabel htmlFor="settings-theme">Theme</FormRowLabel>
            <FormRowDescription data-testid="description">
              Applies on every device.
            </FormRowDescription>
          </FormRowHeading>
          <FormRowControl data-testid="control">
            <select id="settings-theme">
              <option>Ember</option>
            </select>
          </FormRowControl>
        </FormRow>
        <FormRow data-testid="plain-row">
          <FormRowHeading>
            <FormRowLabel data-testid="plain-label">Reset every day</FormRowLabel>
          </FormRowHeading>
          <FormRowControl>
            <button type="button">Reset</button>
          </FormRowControl>
        </FormRow>
      </FormRows>
    </Page>
  );
}

describe("the Form body", () => {
  it("stacks on the shared page frame, with no layout wrapper of its own", () => {
    const { container } = render(<ExampleSettings />);

    expect([...screen.getByTestId("page").classList]).toEqual(
      expect.arrayContaining(["w-full", "p-4", "gap-6"]),
    );
    expect(container.querySelector('[data-slot="form-layout"]')).toBeNull();
    expect(container.querySelector("main")).toBeNull();
  });

  it("caps the rows at the reading measure and leaves the frame full width", () => {
    render(<ExampleSettings />);

    expect([...screen.getByTestId("rows").classList]).toContain("max-w-2xl");
    expect([...screen.getByTestId("page").classList]).not.toContain("max-w-2xl");
  });
});

describe("settings rows", () => {
  it("divides the rows in one surface with a hairline", () => {
    render(<ExampleSettings />);

    expect([...screen.getByTestId("rows").classList]).toEqual(
      expect.arrayContaining(["divide-y", "divide-border", "border", "rounded-12"]),
    );
  });

  it("opens a column for the icon only on the rows that carry one", () => {
    render(<ExampleSettings />);

    expect([...screen.getByTestId("row").classList]).toEqual(
      expect.arrayContaining([
        "grid",
        "items-center",
        "grid-cols-[1fr_auto]",
        "has-data-[slot=form-row-icon]:grid-cols-[auto_1fr_auto]",
      ]),
    );
    expect(screen.getByTestId("icon").getAttribute("aria-hidden")).toBe("true");
    expect([...screen.getByTestId("icon").classList]).toContain("size-9");
  });

  it("floors the row at 64px, so a control does not change its height", () => {
    render(<ExampleSettings />);

    expect([...screen.getByTestId("row").classList]).toEqual(
      expect.arrayContaining(["min-h-16", "px-4", "py-3", "gap-3"]),
    );
  });

  it("puts the label and its description in the cell that grows, and the control opposite", () => {
    render(<ExampleSettings />);

    const heading = screen.getByTestId("heading");
    expect([...heading.classList]).toEqual(expect.arrayContaining(["min-w-0", "flex-col"]));
    expect(heading.contains(screen.getByText("Theme"))).toBe(true);
    expect(heading.contains(screen.getByTestId("description"))).toBe(true);
    expect([...screen.getByTestId("description").classList]).toContain("text-aux");
    expect([...screen.getByTestId("control").classList]).toContain("justify-self-end");
    expect(screen.getByTestId("control").contains(screen.getByRole("combobox"))).toBe(true);
  });

  it("labels the row's control, so clicking the label reaches it", () => {
    render(<ExampleSettings />);

    const label = screen.getByText("Theme");
    expect(label.tagName).toBe("LABEL");
    expect(label.getAttribute("for")).toBe("settings-theme");
    expect(screen.getByLabelText("Theme")).toBe(screen.getByRole("combobox"));
  });

  it("renders a label with nothing to point at as plain text", () => {
    render(<ExampleSettings />);

    const label = screen.getByTestId("plain-label");
    expect(label.tagName).toBe("DIV");
    expect([...label.classList]).toContain("text-ui");
  });
});
