import type * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { Button } from "./button.js";
import { Command, CommandInput } from "./command.js";
import { IconButton } from "./icon-button.js";
import { Input } from "./input.js";
import { SegmentedControl } from "./segmented-control.js";
import { Select, SelectTrigger, SelectValue } from "./select.js";
import { Tabs, TabsList, TabsTrigger } from "./tabs.js";
import { Textarea } from "./textarea.js";
import { Toggle } from "./toggle.js";

afterEach(cleanup);

/**
 * One vocabulary, one height per name: `sm` is 28px and `md` 36px on every
 * inline control, because each reads the same `--control-h-*` step.
 *
 * These assert the token a control resolves its height through rather than a
 * pixel count — jsdom does no layout, and the pixel lives in the host's
 * `:root`. That is the contract that matters at a call site: two controls that
 * name one size cannot come out different heights, whatever the host sets the
 * step to. A component that grows a private ladder fails here.
 *
 * The rendered geometry is measured in
 * `packages/web/e2e/control-size-vocabulary.spec.ts`.
 */
const SHARED_STEPS = ["sm", "md"] as const;

/**
 * `lg` (44px) and `xs` (24px) are the Button family's, not the vocabulary's. A
 * field or a switcher never appears in the rows they serve — `lg` is a 44px hit
 * area for a square icon control, `xs` a chip beside body text — so neither
 * ever exercises the cross-component agreement the shared steps exist for.
 *
 * Only the square members carry `lg`: IconButton and Button's `icon-lg`. A
 * labelled Button has no `lg`, so there is no non-square case to assert.
 */
const BUTTON_FAMILY_STEPS = ["lg"] as const;

type Step = (typeof SHARED_STEPS)[number] | (typeof BUTTON_FAMILY_STEPS)[number];

function heightToken(step: Step): string {
  return `--control-h-${step}`;
}

/**
 * The two padding groups, keyed by how a member's content sits: content that
 * starts at an alignment edge reads `start`, centred content reads `center`.
 *
 * Every padding assertion below checks both directions — the group the member
 * belongs to is present *and* the other one is absent. One direction alone
 * passes for the wrong reason on `Button`, where `size` writes the centre step
 * and the `align` compound row overwrites it: the two collide on `px-`, `cn`
 * resolves them last-wins, and a row that stopped winning would leave the
 * centre step in place with the start assertion still green.
 */
function startPadding(step: Step): string {
  return `px-[var(--control-px-start-${step})]`;
}

function centerPadding(step: Step): string {
  return `px-[var(--control-px-center-${step})]`;
}

function expectStartPadding(className: string, step: Step): void {
  expect(className).toContain(startPadding(step));
  expect(className).not.toContain("--control-px-center-");
}

function expectCenterPadding(className: string, step: Step): void {
  expect(className).toContain(centerPadding(step));
  expect(className).not.toContain("--control-px-start-");
}

describe("the shared control size vocabulary", () => {
  describe.each(SHARED_STEPS)("at %s", (step) => {
    it("sizes a Button off the shared step", () => {
      render(<Button size={step}>Save</Button>);

      expect(screen.getByRole("button").className).toContain(heightToken(step));
    });

    it("sizes a square Button off the shared step", () => {
      render(<Button size={`icon-${step}`} aria-label="Close" />);

      // A square utility rather than a height one: a square control constrains
      // both axes from the one step, so it stays square as the step moves.
      expect(screen.getByRole("button", { name: "Close" }).className).toContain(
        `size-[var(${heightToken(step)})]`,
      );
    });

    it("sizes an IconButton off the shared step", () => {
      render(<IconButton size={step} label="Close" icon={<span aria-hidden>x</span>} />);

      expect(screen.getByRole("button", { name: "Close" }).className).toContain(
        `size-[var(${heightToken(step)})]`,
      );
    });

    it("sizes an Input off the shared step", () => {
      render(<Input aria-label="Search" size={step} />);

      expect(screen.getByRole("textbox", { name: "Search" }).className).toContain(
        heightToken(step),
      );
    });

    it("sizes a SelectTrigger off the shared step", () => {
      render(
        <Select>
          <SelectTrigger size={step}>
            <SelectValue placeholder="Newest first" />
          </SelectTrigger>
        </Select>,
      );
      const trigger = screen.getByRole("combobox");

      // The trigger selects its geometry through `data-size`, so both halves
      // have to agree or the height class never applies.
      expect(trigger.getAttribute("data-size")).toBe(step);
      expect(trigger.className).toContain(`data-[size=${step}]:h-[var(${heightToken(step)})]`);
    });

    it("sizes a SegmentedControl track off the shared step", () => {
      render(
        <SegmentedControl
          aria-label="Sessions view"
          options={[{ value: "overview", label: "Overview" }]}
          value="overview"
          onValueChange={() => {}}
          size={step}
        />,
      );

      expect(screen.getByRole("radiogroup", { name: "Sessions view" }).className).toContain(
        heightToken(step),
      );
    });

    it("sizes a Toggle off the shared step", () => {
      render(
        <Toggle size={step} pressed={false} onPressedChange={() => {}}>
          Bold
        </Toggle>,
      );

      expect(screen.getByRole("button", { name: "Bold" }).className).toContain(heightToken(step));
    });

    it("pads a centred Button from the centre group", () => {
      render(<Button size={step}>Save</Button>);

      expectCenterPadding(screen.getByRole("button").className, step);
    });

    it.each([
      "start",
      "between",
    ] as const)("pads an align=%s Button from the start group instead", (align) => {
      render(
        <Button size={step} align={align}>
          Save
        </Button>,
      );

      // The label is an alignment edge here, so it lands on the same inset as
      // every field stacked above it — the whole reason `align` carries
      // padding rather than only `justify-*`.
      expectStartPadding(screen.getByRole("button").className, step);
    });

    it("pads a Toggle from the centre group, as Button's heir", () => {
      render(
        <Toggle size={step} pressed={false} onPressedChange={() => {}}>
          Bold
        </Toggle>,
      );

      expectCenterPadding(screen.getByRole("button", { name: "Bold" }).className, step);
    });

    it("pads an Input from the start group", () => {
      render(<Input aria-label="Search" size={step} />);

      expectStartPadding(screen.getByRole("textbox", { name: "Search" }).className, step);
    });

    it("pads a SelectTrigger from the start group, symmetrically", () => {
      render(
        <Select>
          <SelectTrigger size={step}>
            <SelectValue placeholder="Newest first" />
          </SelectTrigger>
        </Select>,
      );
      const cls = screen.getByRole("combobox").className;

      expectStartPadding(cls, step);
      // Symmetric despite the chevron: optically correcting a glyph against the
      // padded edge is the Control role's decision to make, not one component's.
      expect(cls).not.toContain("pr-[calc(");
      expect(cls).not.toContain("pl-[calc(");
    });

    it("pads a SegmentedControl segment from the centre group", () => {
      render(
        <SegmentedControl
          aria-label="Sessions view"
          options={[{ value: "overview", label: "Overview" }]}
          value="overview"
          onValueChange={() => {}}
          size={step}
        />,
      );

      expectCenterPadding(screen.getByRole("radio", { name: "Overview" }).className, step);
    });
  });

  describe.each(BUTTON_FAMILY_STEPS)("at %s, which only the Button family carries", (step) => {
    it("sizes the square Button and IconButton off the same step", () => {
      render(
        <>
          <Button size={`icon-${step}`} aria-label="Close" />
          <IconButton size={step} label="Open" icon={<span aria-hidden>x</span>} />
        </>,
      );

      expect(screen.getByRole("button", { name: "Close" }).className).toContain(
        `size-[var(${heightToken(step)})]`,
      );
      expect(screen.getByRole("button", { name: "Open" }).className).toContain(
        `size-[var(${heightToken(step)})]`,
      );
    });

    // No padding assertion here: the square members set `size-*` and no
    // horizontal inset, and no labelled member carries this step.

    it("is not offered by the field members", () => {
      // A compile-time guarantee first — these props reject the step — and the
      // runtime half here, so removing the type without removing the geometry
      // still fails. The point is that no field can be dragged into a
      // prominence row by name.
      // @ts-expect-error `lg` is not part of SelectTrigger's vocabulary.
      const selectSize: React.ComponentProps<typeof SelectTrigger>["size"] = step;
      // @ts-expect-error `lg` is not part of SegmentedControl's vocabulary.
      const segmentedSize: React.ComponentProps<typeof SegmentedControl>["size"] = step;

      expect([selectSize, segmentedSize]).toEqual([step, step]);
    });
  });

  describe("the spellings that predate the vocabulary", () => {
    it("gives a `default` Button the md geometry", () => {
      render(<Button size="default">Save</Button>);
      const button = screen.getByRole("button");

      expect(button.className).toContain(heightToken("md"));
      // `data-size` is a styling and test hook, so it carries the canonical
      // name whichever spelling the caller wrote.
      expect(button.getAttribute("data-size")).toBe("md");
    });

    it("gives an `icon` Button the icon-md geometry", () => {
      render(<Button size="icon" aria-label="Close" />);
      const button = screen.getByRole("button", { name: "Close" });

      expect(button.className).toContain(`size-[var(${heightToken("md")})]`);
      expect(button.getAttribute("data-size")).toBe("icon-md");
    });

    it("gives a `default` Input the md geometry", () => {
      render(<Input aria-label="Search" size="default" />);
      const field = screen.getByRole("textbox", { name: "Search" });

      expect(field.className).toContain(heightToken("md"));
      expect(field.getAttribute("data-size")).toBe("md");
    });

    it.each([
      ["default", "md"],
      ["icon", "icon-md"],
    ] as const)("normalizes a `%s` Toggle to %s", (spelling, canonical) => {
      render(
        <Toggle size={spelling} pressed={false} onPressedChange={() => {}} aria-label="Bold" />,
      );

      // Toggle derives its size union from `buttonVariants`, so it inherits
      // every alias Button carries and has to normalize all of them — this is
      // the member where a hand-written mapping was easiest to get wrong.
      expect(screen.getByRole("button", { name: "Bold" }).getAttribute("data-size")).toBe(
        canonical,
      );
    });

    it("gives a `default` SelectTrigger the md geometry", () => {
      render(
        <Select>
          <SelectTrigger size="default">
            <SelectValue placeholder="Newest first" />
          </SelectTrigger>
        </Select>,
      );

      expect(screen.getByRole("combobox").getAttribute("data-size")).toBe("md");
    });
  });

  describe("the members with no size axis", () => {
    it("pads a Textarea from the start group at md", () => {
      render(<Textarea aria-label="Notes" />);

      expectStartPadding(screen.getByRole("textbox", { name: "Notes" }).className, "md");
    });

    it("pads a CommandInput row from the start group at md", () => {
      render(
        <Command>
          <CommandInput placeholder="Search…" />
        </Command>,
      );
      const wrapper = screen
        .getByPlaceholderText("Search…")
        .closest('[data-slot="command-input-wrapper"]');

      expectStartPadding(wrapper?.className ?? "", "md");
    });

    it("pads a TabsTrigger from the centre group's sm step", () => {
      render(
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
          </TabsList>
        </Tabs>,
      );

      // A picked step, not a looked-up one: the list is 32px, between the two
      // shared heights, so the trigger takes the smaller of the two rather than
      // claiming a fit. `docs/ui/component-roles.md` records it as a divergence.
      expectCenterPadding(screen.getByRole("tab", { name: "Overview" }).className, "sm");
    });
  });

  describe("the steps that sit off the scale", () => {
    it("keeps the xs Button at 24px, below the smallest step", () => {
      render(<Button size="xs">Save</Button>);
      const cls = screen.getByRole("button").className;

      // A chip-sized button for dense toolbars, with no field counterpart to
      // line up with — so it names no shared step and joins no row.
      expect(cls).toContain("h-6");
      expect(cls).not.toContain("--control-h-");
    });

    it("pads the xs Button from a spacing step, neither group carrying one", () => {
      render(<Button size="xs">Save</Button>);
      const cls = screen.getByRole("button").className;

      expect(cls).toContain("px-2");
      expect(cls).not.toContain("--control-px-");
    });

    it("keeps the xs IconButton at 24px, below the smallest step", () => {
      render(<IconButton size="xs" label="Close" icon={<span aria-hidden>x</span>} />);
      const cls = screen.getByRole("button", { name: "Close" }).className;

      expect(cls).toContain("size-6");
      expect(cls).not.toContain("--control-h-");
    });

    it("matches IconButton to Button's square variant at every step both carry", () => {
      for (const [step, iconStep] of [
        ["sm", "icon-sm"],
        ["md", "icon-md"],
        ["lg", "icon-lg"],
      ] as const) {
        const { unmount } = render(
          <>
            <IconButton size={step} label="Close" icon={<span aria-hidden>x</span>} />
            <Button size={iconStep} aria-label="Open" />
          </>,
        );
        const iconButton = screen.getByRole("button", { name: "Close" }).className;
        const button = screen.getByRole("button", { name: "Open" }).className;

        // Two square icon controls in one kit, so the box has to agree: height
        // and radius both, or a toolbar mixing them comes out ragged.
        expect(iconButton).toContain(`size-[var(${heightToken(step)})]`);
        expect(button).toContain(`size-[var(${heightToken(step)})]`);
        expect(iconButton).toContain(`rounded-[var(--control-r-${step})]`);
        expect(button).toContain(`rounded-[var(--control-r-${step})]`);
        unmount();
      }
    });
  });
});
