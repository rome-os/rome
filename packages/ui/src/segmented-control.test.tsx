import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { SegmentedControl, type SegmentedControlOption } from "./segmented-control.js";

afterEach(cleanup);

const OPTIONS = [
  { value: "overview", label: "Overview" },
  { value: "sessions", label: "Sessions" },
];

describe("SegmentedControl", () => {
  it.each([
    ["sm", "px-[var(--control-px-center-sm)]"],
    ["md", "px-[var(--control-px-center-md)]"],
  ] as const)("pads a %s segment from the centre group", (size, px) => {
    render(
      <SegmentedControl
        aria-label="Sessions view"
        options={OPTIONS}
        value="overview"
        onValueChange={() => {}}
        size={size}
      />,
    );

    const group = screen.getByRole("radiogroup", { name: "Sessions view" });
    expect(group.className).toContain("p-1");
    for (const segment of screen.getAllByRole("radio")) {
      // A segment's label is centred, so it pads to the same inset a Button of
      // that size does — never the start edge a field reads.
      expect(segment.className).toContain(px);
      expect(segment.className).not.toContain("--control-px-start-");
    }
  });

  it("exposes a named radiogroup, not a tablist", () => {
    render(
      <SegmentedControl
        aria-label="Sessions view"
        options={OPTIONS}
        value="overview"
        onValueChange={() => {}}
      />,
    );

    // The whole point of splitting this out of Tabs: a control with no panel
    // per choice must not announce itself as a tablist.
    expect(screen.getByRole("radiogroup", { name: "Sessions view" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("marks only the segment matching `value` as checked", () => {
    render(
      <SegmentedControl
        aria-label="Sessions view"
        options={OPTIONS}
        value="sessions"
        onValueChange={() => {}}
      />,
    );

    expect(screen.getByRole("radio", { name: "Sessions" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "Overview" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("reports the newly picked value to the caller", () => {
    const onValueChange = rs.fn();
    render(
      <SegmentedControl
        aria-label="Sessions view"
        options={OPTIONS}
        value="overview"
        onValueChange={onValueChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Sessions" }));

    expect(onValueChange).toHaveBeenCalledWith("sessions");
  });

  it("stays on the caller-supplied value until the caller changes it", () => {
    const { rerender } = render(
      <SegmentedControl
        aria-label="Sessions view"
        options={OPTIONS}
        value="overview"
        onValueChange={() => {}}
      />,
    );

    // Controlled-only: clicking does not move the selection on its own, so a
    // caller that rejects the change (a guarded navigation, say) can't end up
    // with the control showing a state the app is not in.
    fireEvent.click(screen.getByRole("radio", { name: "Sessions" }));
    expect(screen.getByRole("radio", { name: "Overview" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    rerender(
      <SegmentedControl
        aria-label="Sessions view"
        options={OPTIONS}
        value="sessions"
        onValueChange={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: "Sessions" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("does not report a change for a disabled segment", () => {
    const onValueChange = rs.fn();
    render(
      <SegmentedControl
        aria-label="Sessions view"
        options={[...OPTIONS, { value: "archived", label: "Archived", disabled: true }]}
        value="overview"
        onValueChange={onValueChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("does not report a change from any segment while the group is disabled", () => {
    const onValueChange = rs.fn();
    render(
      <SegmentedControl
        aria-label="Sessions view"
        options={OPTIONS}
        value="overview"
        onValueChange={onValueChange}
        disabled
      />,
    );

    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(radio);
    }

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("leaves the other segments enabled when only one option is disabled", () => {
    const onValueChange = rs.fn();
    render(
      <SegmentedControl
        aria-label="Sessions view"
        options={[...OPTIONS, { value: "archived", label: "Archived", disabled: true }]}
        value="overview"
        onValueChange={onValueChange}
      />,
    );

    expect((screen.getByRole("radio", { name: "Archived" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Sessions" }));

    expect(onValueChange).toHaveBeenCalledWith("sessions");
  });

  it("describes a titled segment to assistive tech without any interaction", () => {
    render(
      <SegmentedControl
        aria-label="Epic filter"
        options={[
          { value: "all", label: "All" },
          { value: "open", label: "Open", title: "Only projects with unfinished work" },
        ]}
        value="all"
        onValueChange={() => {}}
      />,
    );

    // The visible tooltip is dismissed by the click Radix synthesizes when a
    // segment is reached with the arrow keys, so the description a screen
    // reader reads on focus can't be the tooltip's — it is attached outright.
    const open = screen.getByRole("radio", { name: "Open" });
    const describedBy = open.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "Only projects with unfinished work",
    );

    expect(screen.getByRole("radio", { name: "All" }).getAttribute("aria-describedby")).toBeNull();
  });

  it("explains a terse segment on keyboard focus, not hover alone", async () => {
    render(
      <SegmentedControl
        aria-label="Epic filter"
        options={[
          { value: "all", label: "All" },
          { value: "open", label: "Open", title: "Only projects with unfinished work" },
        ]}
        value="all"
        onValueChange={() => {}}
      />,
    );

    // Arrow-key navigation lands focus on the segment; the explanation has to
    // arrive there too, or it is pointer-only and invisible to a keyboard user.
    const open = screen.getByRole("radio", { name: "Open" });
    fireEvent.focus(open);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Only projects with unfinished work");
  });

  it("still reports changes for a segment carrying a title", () => {
    const onValueChange = rs.fn();
    render(
      <SegmentedControl
        aria-label="Epic filter"
        options={[
          { value: "all", label: "All" },
          { value: "open", label: "Open", title: "Only projects with unfinished work" },
        ]}
        value="all"
        onValueChange={onValueChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Open" }));

    expect(onValueChange).toHaveBeenCalledWith("open");
  });

  it("hands the caller its own value union back, not a bare string", () => {
    type EpicFilter = "all" | "open" | "archived";
    const epicOptions: SegmentedControlOption<EpicFilter>[] = [
      { value: "all", label: "All" },
      { value: "open", label: "Open" },
      { value: "archived", label: "Archived" },
    ];
    const seen: string[] = [];

    render(
      <SegmentedControl
        aria-label="Epic filter"
        options={epicOptions}
        value="all"
        onValueChange={(next) => {
          // Type-level assertion: if `T` widened back to `string`, the switch
          // stops being exhaustive and the `never` binding fails to compile.
          switch (next) {
            case "all":
            case "open":
            case "archived":
              seen.push(next);
              break;
            default: {
              const unreachable: never = next;
              throw new Error(`unhandled ${String(unreachable)}`);
            }
          }
        }}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));

    expect(seen).toEqual(["archived"]);
  });
});
