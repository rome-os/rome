import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Badge } from "./badge.js";
import { Button } from "./button.js";
import { FieldDescription, FieldError, FieldGroupLabel, FieldLabel, FormError } from "./field.js";
import { Input } from "./input.js";
import { SegmentedControl } from "./segmented-control.js";
import { Select, SelectTrigger, SelectValue } from "./select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";
import { Textarea } from "./textarea.js";

afterEach(cleanup);

describe("control typography roles", () => {
  it.each(["xs", "sm", "default"] as const)("keeps a %s Button label on the UI role", (size) => {
    render(<Button size={size}>Save</Button>);

    const classes = screen.getByRole("button", { name: "Save" }).classList;
    expect(classes).toContain("text-ui");
    expect(classes).not.toContain("font-medium");
  });

  // The square members are the only ones left on the 44px step, and they carry
  // no label of their own. `text-ui` is still declared on them, because an
  // em-sized glyph and a tooltip resolve against it.
  it("keeps the square 44px members on the UI role", () => {
    render(<Button size="icon-lg" aria-label="Close" />);

    expect(screen.getByRole("button", { name: "Close" }).classList).toContain("text-ui");
  });

  // The 28px step is the roster's one field exception: it sits in a compact row
  // beside a Button and a SelectTrigger already on UI, so it reads UI too. The
  // negative half matters as much as the positive — the role lives in the base
  // class and is displaced by tailwind-merge, not replaced at the source, so a
  // regression shows up as both roles surviving rather than as the wrong one.
  it("uses UI for a text field on the 28px step", () => {
    render(<Input aria-label="Filter" size="sm" />);

    const classes = screen.getByRole("textbox", { name: "Filter" }).classList;
    expect(classes).toContain("text-ui");
    expect(classes).not.toContain("text-body");
  });

  it("uses Body for text fields at every viewport width", () => {
    render(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
      </>,
    );

    for (const field of [
      screen.getByRole("textbox", { name: "Name" }),
      screen.getByRole("textbox", { name: "Notes" }),
    ]) {
      expect(field.classList).toContain("text-body");
      expect([...field.classList].some((token) => token.startsWith("md:text-"))).toBe(false);
    }
  });

  it("uses UI for field labels and Auxiliary for hints and errors", () => {
    render(
      <>
        <FieldLabel>Name</FieldLabel>
        <FieldGroupLabel>Visibility</FieldGroupLabel>
        <FieldDescription>Shown on your profile.</FieldDescription>
        <FieldError errors={["Name is required."]} />
        <FormError>Could not save.</FormError>
      </>,
    );

    for (const label of [screen.getByText("Name"), screen.getByText("Visibility")]) {
      expect(label.classList).toContain("text-ui");
      expect(label.classList).not.toContain("font-medium");
    }
    for (const message of [
      screen.getByText("Shown on your profile."),
      screen.getByText("Name is required."),
      screen.getByText("Could not save."),
    ]) {
      expect(message.classList).toContain("text-aux");
    }
  });

  it("uses UI for segmented options at both control sizes", () => {
    for (const size of ["sm", "md"] as const) {
      const { unmount } = render(
        <SegmentedControl
          aria-label={`${size} view`}
          options={[{ value: "all", label: "All" }]}
          value="all"
          onValueChange={() => {}}
          size={size}
        />,
      );

      const option = screen.getByRole("radio", { name: "All" });
      expect(option.classList).toContain("text-ui");
      expect(option.classList).not.toContain("font-medium");
      unmount();
    }
  });

  it("uses UI for tab labels and Body for tab-panel values", () => {
    render(
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">Profile settings</TabsContent>
      </Tabs>,
    );

    const tab = screen.getByRole("tab", { name: "Profile" });
    expect(tab.classList).toContain("text-ui");
    expect(tab.classList).not.toContain("font-medium");
    expect(screen.getByRole("tabpanel").classList).toContain("text-body");
  });

  it("uses UI for select triggers", () => {
    render(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Newest first" />
        </SelectTrigger>
      </Select>,
    );

    expect(screen.getByRole("combobox").classList).toContain("text-ui");
  });

  it("uses Badge for badges without changing their geometry", () => {
    render(<Badge>ready</Badge>);
    const badge = screen.getByText("ready");

    expect(badge.classList).toContain("text-badge");
    expect(badge.classList).toContain("h-[var(--badge-h)]");
  });
});
