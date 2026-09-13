import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "./cn.js";

/**
 * A yes/no choice in a form, or one pick in a set where any number may be on.
 *
 * Reach for `Switch` instead when flipping the value takes effect at once,
 * with no submit. Reach for `Toggle` when the control sits in a toolbar.
 *
 * A selection control: 16px square, off the control scale, with the hit area
 * reaching past the box through a pseudo-element so the row it sits in keeps
 * the label's height. It grows 12px sideways, where nothing is stacked, and
 * 4px vertically — half the gap a column of these sits at, so one box's hit
 * area stops before the next box begins. Labelling each with a `<label>` is
 * what makes the whole row a target; the pseudo-element only covers a bare
 * checkbox. It is labelled by a sibling `<label>` or by `aria-label`, never by
 * text of its own. An indeterminate box renders the mixed state and reports
 * `aria-checked="mixed"`, whether it was set through `checked` or
 * `defaultChecked`.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "group peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-4 border border-input bg-surface transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-1",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
        "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        // The edge stays outside the box, where a field's sits on its border.
        // A checked box is filled to its border, so an inset edge would land on
        // `primary` over `primary` and vanish in the one state it has to mark.
        "outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50",
        "aria-invalid:outline-solid aria-invalid:outline-2 aria-invalid:outline-offset-0 aria-invalid:outline-destructive",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {/* Which glyph shows is decided by the box's own state, not by the
            `checked` prop: an uncontrolled box has no such prop, and reading it
            would draw a check over `aria-checked="mixed"`. */}
        <Check
          className="size-3 group-data-[state=indeterminate]:hidden"
          strokeWidth={3}
          aria-hidden
        />
        <Minus
          className="hidden size-3 group-data-[state=indeterminate]:block"
          strokeWidth={3}
          aria-hidden
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
