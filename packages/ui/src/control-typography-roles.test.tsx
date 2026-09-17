import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Badge } from "./badge.js";
import { Button } from "./button.js";
import { FieldDescription, FieldError, FieldGroupLabel, FieldLabel, FormError } from "./field.js";
import { Input } from "./input.js";
import { SegmentedControl } from "./segmented-control.js";
import { Select, SelectTrigger, SelectValue } from "./select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";
import { TYPOGRAPHY_ROLES } from "./typography-roles.js";
import { Textarea } from "./textarea.js";

afterEach(cleanup);

describe("control typography roles", () => {
  it.each(["xs", "sm", "default"] as const)("keeps a %s Button label on the UI role", (size) => {
    render(
      <Button size={size} variant="outline">
        Save
      </Button>,
    );

    const classes = screen.getByRole("button", { name: "Save" }).classList;
    expect(classes).toContain("text-ui");
    expect(classes).not.toContain("font-medium");
  });

  // The primary fill lifts its label to 500; the role stays UI so the size
  // and line box match the controls beside it.
  it("lifts only the primary Button label to the 500 step", () => {
    render(
      <>
        <Button>Save</Button>
        <Button variant="secondary">Cancel</Button>
      </>,
    );

    const primary = screen.getByRole("button", { name: "Save" }).classList;
    expect(primary).toContain("text-ui");
    expect(primary).toContain("font-medium");
    expect(screen.getByRole("button", { name: "Cancel" }).classList).not.toContain("font-medium");
  });

  // The square members are the only ones left on the 44px step, and they carry
  // no label of their own. `text-ui` is still declared on them, because an
  // em-sized glyph and a tooltip resolve against it.
  it("keeps the square 44px members on the UI role", () => {
    render(<Button size="icon-lg" aria-label="Close" />);

    expect(screen.getByRole("button", { name: "Close" }).classList).toContain("text-ui");
  });

  // A field is a control and reads UI at every step and width, like the
  // Button and SelectTrigger beside it. The negative half matters: a Body role
  // leaves a field two points larger than its row.
  it("uses UI for text fields at every step and viewport width", () => {
    render(
      <>
        <Input aria-label="Name" />
        <Input aria-label="Filter" size="sm" />
        <Textarea aria-label="Notes" />
      </>,
    );

    for (const field of [
      screen.getByRole("textbox", { name: "Name" }),
      screen.getByRole("textbox", { name: "Filter" }),
      screen.getByRole("textbox", { name: "Notes" }),
    ]) {
      expect(field.classList).toContain("text-ui");
      expect(field.classList).not.toContain("text-composer");
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

  it("uses UI for tab labels and leaves the tab panel roleless", () => {
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
    // The panel is a container, not a text element: whatever it holds declares
    // its own role, so a role here would silently size any undeclared
    // descendant instead of the surface's author choosing one. Checked against
    // the whole roster rather than one name, so a future role cannot be added
    // to the panel without this failing.
    const panelRoles = [...screen.getByRole("tabpanel").classList].filter((token) =>
      TYPOGRAPHY_ROLES.includes(token.replace(/^text-/, "")),
    );
    expect(panelRoles).toEqual([]);
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
