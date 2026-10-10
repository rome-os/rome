import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

import { cn } from "./cn.js";

/**
 * One pick from a short set of options that all show at once.
 *
 * Reach for `Select` instead when the set is long or the options need no
 * explanation. Reach for `SegmentedControl` when the choice switches or
 * filters one view rather than setting a value.
 *
 * A layout: the group owns the gap between its items and paints nothing of
 * its own. Radix supplies the roving focus and arrow-key movement the
 * radiogroup role promises. The name is required rather than documented: a
 * radiogroup without one is unusable by screen reader.
 *
 * The group lays its items out along its own `orientation`, because the
 * orientation decides which axis an item may grow its hit area on.
 */
type RadioGroupProps = Omit<
  React.ComponentProps<typeof RadioGroupPrimitive.Root>,
  "aria-label" | "aria-labelledby"
> &
  ({ "aria-label": string } | { "aria-labelledby": string });

function RadioGroup({ className, ...props }: RadioGroupProps) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-2 data-[orientation=horizontal]:grid-flow-col", className)}
      {...props}
    />
  );
}

/**
 * One option of a `RadioGroup`. A selection control: 16px round, off the
 * control scale, with the hit area reaching past the box through a
 * pseudo-element. It grows 12px along the axis the group does not stack on,
 * where there is no neighbour, and 4px along the axis it does — half the
 * group's own gap, so one option's hit area stops before the next option's box
 * begins. Both axes read the group's `orientation`, which is also what its
 * layout follows, so the two cannot disagree. A group set to a gap below
 * `gap-2` has to narrow the inset itself. It is labelled by a sibling
 * `<label>` or by `aria-label`, never by text of its own.
 */
function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-surface transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-1",
        // Radix hands each item the group's orientation, so the hit area
        // follows the axis the options are actually stacked along.
        "data-[orientation=horizontal]:after:-inset-x-1 data-[orientation=horizontal]:after:-inset-y-3",
        "data-[state=checked]:border-primary",
        // Outside the box, for the reason `Checkbox` states: a selection
        // control is a glyph, and its edge has to read against the canvas.
        "outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50",
        "aria-invalid:outline-solid aria-invalid:outline-2 aria-invalid:outline-offset-0 aria-invalid:outline-destructive",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="flex items-center justify-center"
      >
        <span className="size-2 rounded-full bg-primary" aria-hidden />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
export type { RadioGroupProps };
