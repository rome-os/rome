import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Badge } from "./badge.js";
import { Button } from "./button.js";
import { IconButton } from "./icon-button.js";
import { Input } from "./input.js";
import { Select, SelectTrigger } from "./select.js";
import { Tabs, TabsList, TabsTrigger } from "./tabs.js";

afterEach(cleanup);

/**
 * The control scale is written in bracket form (`h-[var(--control-h-md)]`)
 * rather than Tailwind v4's parenthesis shorthand, for one reason: `cn` runs
 * tailwind-merge, which does not classify the shorthand. Both the token class
 * and the caller's class survive the merge and stylesheet order silently
 * decides the winner — so a caller's `className` stops working with no error.
 *
 * These pin the observable consequence rather than the syntax: whatever the
 * primitives are written in, a caller must still be able to resize them.
 */
describe("control scale", () => {
  it("lets a caller override a Button's height", () => {
    render(<Button className="h-9">Save</Button>);
    const cls = screen.getByRole("button").className;

    expect(cls).toContain("h-9");
    expect(cls).not.toContain("--control-h-md");
  });

  it("lets a caller override a Button's text size", () => {
    render(<Button className="text-xs">Save</Button>);
    const cls = screen.getByRole("button").className;

    expect(cls).toContain("text-xs");
    expect(cls).not.toContain("text-ui");
  });

  it("pads the xs Button symmetrically even with a glyph on one side", () => {
    render(
      <Button size="xs">
        Save
        <span data-icon="inline-end" aria-hidden>
          →
        </span>
      </Button>,
    );
    const cls = screen.getByRole("button", { name: "Save" }).className;

    // Optical correction for a glyph belongs to the Control role as a whole, so
    // no member trims the side an icon sits on: `data-icon` marks the glyph, and
    // nothing reads it for padding.
    expect(cls).toContain("px-2");
    expect(cls).not.toContain("has-data-[icon=inline-end]:pr-");
    expect(cls).not.toContain("has-data-[icon=inline-start]:pl-");
  });

  it("lets a caller override an Input's padding and radius", () => {
    render(<Input aria-label="Search" className="rounded-full px-2" />);
    const cls = screen.getByRole("textbox", { name: "Search" }).className;

    expect(cls).toContain("rounded-full");
    expect(cls).toContain("px-2");
    expect(cls).not.toContain("--control-r-md");
    expect(cls).not.toContain("--control-px-start-md");
  });

  it("lets a caller override a Badge's height", () => {
    render(<Badge className="h-6">12</Badge>);
    const cls = screen.getByText("12").className;

    expect(cls).toContain("h-6");
    expect(cls).not.toContain("--badge-h");
  });

  it("sizes an IconButton's xs step to 24px", () => {
    render(<IconButton size="xs" label="Close" icon={<span aria-hidden>x</span>} />);
    const cls = screen.getByRole("button", { name: "Close" }).className;

    // 24px is the WCAG 2.5.8 minimum — the step has nowhere to shrink to, and
    // a touch surface pairs it with `touch-target` to clear the 44px floor.
    expect(cls).toContain("size-6");
  });

  it("names an IconButton for assistive tech and for the tooltip", () => {
    render(<IconButton label="Close" icon={<span aria-hidden>x</span>} />);

    expect(screen.getByRole("button", { name: "Close" }).title).toBe("Close");
  });

  it("gives an IconButton the same focus edge as every other control", () => {
    render(<IconButton label="Close" icon={<span aria-hidden>x</span>} />);
    const cls = screen.getByRole("button", { name: "Close" }).className;

    expect(cls).toContain("focus-visible:outline-solid");
    expect(cls).toContain("focus-visible:outline-2");
    expect(cls).toContain("focus-visible:outline-offset-0");
    expect(cls).toContain("focus-visible:outline-ring");
    expect(cls).not.toMatch(/focus-visible:ring-/);

    // The reserved width answers to the layout invariant, not to focus: height
    // is explicit but width is auto, so a border a caller paints has to already
    // occupy the box.
    expect(cls).toContain("border-transparent");
  });

  it("sizes an IconButton's glyph from the step rather than the call site", () => {
    const glyph = <svg data-testid="glyph" />;
    const steps = [
      ["xs", "size-3"],
      ["sm", "size-3.5"],
      ["md", "size-4"],
      ["lg", "size-4"],
    ] as const;

    for (const [step, expected] of steps) {
      render(<IconButton size={step} label={step} icon={glyph} />);
      const cls = [...screen.getByRole("button", { name: step }).classList];
      const rules = cls.filter((token) => token.startsWith("[&_svg:not([class*='size-'])]:"));

      expect(cls).toContain(`[&_svg:not([class*='size-'])]:${expected}`);
      expect(screen.getByTestId("glyph").getAttribute("class")).toBeNull();
      // Exactly one survives. The base carries `size-4` and the two small steps
      // override it, so `cn` has to drop the loser — the same arrangement
      // `Button` uses, and the reason both ladders agree at every shared name.
      // Were tailwind-merge to stop classifying an arbitrary-variant utility,
      // both would survive and stylesheet order would silently pick.
      expect(rules).toHaveLength(1);
      cleanup();
    }
  });

  it("stands aside for a glyph the caller did size", () => {
    render(<IconButton label="Close" icon={<svg data-testid="glyph" className="size-5" />} />);

    // The rule stays on the button either way — it is the `:not()` in its
    // selector that stops matching, not `cn` dropping a class, because the two
    // sit on different elements and tailwind-merge never compares them.
    expect([...screen.getByRole("button", { name: "Close" }).classList]).toContain(
      "[&_svg:not([class*='size-'])]:size-4",
    );
    expect([...screen.getByTestId("glyph").classList]).toContain("size-5");
  });

  it("keeps the glyph rule when the caller resizes the IconButton itself", () => {
    render(
      <IconButton size="sm" label="Close" icon={<span aria-hidden>x</span>} className="h-7" />,
    );
    const cls = [...screen.getByRole("button", { name: "Close" }).classList];

    // `h-7` collides with the step's own box and wins; the glyph rule shares no
    // group with it and must survive that merge.
    expect(cls).toContain("h-7");
    expect(cls).toContain("[&_svg:not([class*='size-'])]:size-3.5");
  });

  it("gives every sized Control member the same glyph at the same step", () => {
    // A Select and a Button on one `sm` row disagreed about their glyphs for as
    // long as the size lived on the base rather than on the size axis.
    render(
      <>
        <Button size="sm">Save</Button>
        <Select>
          <SelectTrigger size="sm" aria-label="sm select" />
        </Select>
        <Select>
          <SelectTrigger size="md" aria-label="md select" />
        </Select>
      </>,
    );

    const trigger = (name: string) => [...screen.getByLabelText(name).classList];
    expect([...screen.getByRole("button", { name: "Save" }).classList]).toContain(
      "[&_svg:not([class*='size-'])]:size-3.5",
    );
    expect(trigger("sm select")).toContain("data-[size=sm]:[&_svg:not([class*='size-'])]:size-3.5");
    expect(trigger("md select")).toContain("data-[size=md]:[&_svg:not([class*='size-'])]:size-4");
  });

  it("puts an Input's glyph on the same size axis as the row it sits in", () => {
    const glyph = <svg data-testid="glyph" />;
    render(
      <>
        <Input size="sm" aria-label="sm field" icon={glyph} />
        <Input size="md" aria-label="md field" icon={glyph} />
      </>,
    );

    const slot = (name: string) => {
      const field = screen.getByRole("textbox", { name });
      return [...field.parentElement!.querySelector('[data-slot="input-icon"]')!.classList];
    };

    // Unconditional, unlike Button's: the field reserves the glyph's room as
    // padding on a sibling, which cannot follow an opt-out, so the step's size
    // is the only one that fits the inset it reserved.
    expect(slot("sm field")).toContain("[&_svg]:size-3.5");
    expect(slot("md field")).toContain("[&_svg]:size-4");
    // The reserved inset is the same number as a length, since `calc` takes no
    // class. The two spellings have to agree or the label stops sitting exactly
    // one control gap past the glyph.
    expect([...screen.getByRole("textbox", { name: "sm field" }).classList]).toContain(
      "pl-[calc(var(--control-px-start-sm)+0.875rem+var(--control-gap))]",
    );
  });

  it("falls back to the md step when a caller passes a null size", () => {
    // `size` is `cva`'s variant type, which admits `null` as well as
    // `undefined`, and a destructuring default only fires for `undefined`. The
    // `?? "md"` behind the icon maps is what covers the other half — drop it
    // and a null size indexes to `undefined`, leaving the glyph unsized and the
    // slot uninset with no type error.
    render(<Input size={null} aria-label="null field" icon={<svg data-testid="glyph" />} />);

    const field = screen.getByRole("textbox", { name: "null field" });
    const slot = [...field.parentElement!.querySelector('[data-slot="input-icon"]')!.classList];

    expect(slot).toContain("[&_svg]:size-4");
    expect(slot).toContain("left-[var(--control-px-start-md)]");
  });

  it("sizes a TabsTrigger's glyph at the step it already pads on", () => {
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const cls = [...screen.getByRole("tab", { name: "One" }).classList];

    // No size axis: the 32px list sits between the shared heights, so the
    // trigger takes `sm` for both its inset and its glyph rather than padding
    // at one step and sizing at another.
    expect(cls).toContain("px-[var(--control-px-center-sm)]");
    expect(cls).toContain("[&_svg:not([class*='size-'])]:size-3.5");
  });

  it("lets a caller restyle an IconButton's shape and fill", () => {
    render(
      <IconButton
        label="Send"
        icon={<span aria-hidden>→</span>}
        className="rounded-full bg-success hover:bg-success/90"
      />,
    );
    const cls = screen.getByRole("button", { name: "Send" }).className;

    expect(cls).toContain("rounded-full");
    expect(cls).toContain("bg-success");
    expect(cls).not.toContain("rounded-8");
    expect(cls).not.toContain("hover:bg-surface-hover");
  });

  it("draws focus as one outside edge, never a translucent halo", () => {
    // The design system's focus model: a single 2px outline drawn just outside
    // the control, where it separates from the canvas. It cannot move inside —
    // `ring` sits a step from `primary`/`secondary`/`input` on one ramp, so an
    // inset edge measures 1.08:1 against a filled control. An outline rather
    // than a ring because forced colors mode drops box-shadow. `outline-solid` is
    // load-bearing: the base `outline-none` sets --tw-outline-style:none, which
    // `outline-2` would otherwise inherit and render invisible.
    render(<Input aria-label="Search" />);
    const cls = screen.getByRole("textbox", { name: "Search" }).className;

    expect(cls).toContain("focus-visible:outline-solid");
    expect(cls).toContain("focus-visible:outline-2");
    expect(cls).toContain("focus-visible:outline-offset-0");
    expect(cls).toContain("focus-visible:outline-ring");
    expect(cls).not.toMatch(/focus-visible:ring-/);
    // No border half: a state that recolors a border is a state that needs the
    // border to exist, which is the coupling this model drops.
    expect(cls).not.toMatch(/focus-visible:border-/);
  });

  it("draws the invalid state as the same edge in destructive", () => {
    render(<Input aria-label="Search" />);
    const cls = screen.getByRole("textbox", { name: "Search" }).className;

    expect(cls).toContain("aria-invalid:outline-solid");
    expect(cls).toContain("aria-invalid:outline-2");
    expect(cls).toContain("aria-invalid:outline-offset-0");
    expect(cls).toContain("aria-invalid:outline-destructive");
    expect(cls).not.toMatch(/aria-invalid:ring-/);
    expect(cls).not.toMatch(/aria-invalid:border-/);
  });

  it("uses the Body role at every breakpoint", () => {
    // One role at every width, with no responsive exception. Body is 16px, at
    // the threshold under which iOS Safari zooms a focused field, so no width
    // needs one. Its 20px line box is the controls' own, so a field on the
    // denser role would gain nothing back.
    render(<Input aria-label="Search" />);
    const cls = screen.getByRole("textbox", { name: "Search" }).className;

    expect(cls).toContain("text-body");
    expect(cls).not.toContain("md:text-");
  });
});
