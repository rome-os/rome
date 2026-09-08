import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

import { cn } from "./cn.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.js";

export type SegmentedControlOption<T extends string = string> = {
  value: T;
  label: React.ReactNode;
  /** Optional leading glyph, rendered before the label. */
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Hover/focus explanation for a label too terse to stand on its own. */
  title?: string;
};

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Disables every segment; OR'd with each option's own `disabled`. */
  disabled?: boolean;
  /**
   * `sm` = 28px, `md` = 36px — the shared --control-h-* steps. There is no
   * `lg`: 44px is a prominence step the Button family carries for standalone
   * calls to action, and a switcher never appears in one of those rows.
   */
  size?: "sm" | "md";
  /** Required: a radiogroup with no accessible name is unusable by screen reader. */
  "aria-label": string;
  className?: string;
}

// A segment's label is centred, so its padding is the `center` group's step —
// the same inset a Button of that size takes. The glyph reads off the track
// rather than the segment for the same reason the height does: the track is the
// box that joins a row, and a segment is it minus the track's own padding.
const sizeClasses = {
  sm: {
    track: "h-[var(--control-h-sm)] p-1",
    segment: "gap-1 px-[var(--control-px-center-sm)] [&_svg:not([class*='size-'])]:size-3.5",
  },
  md: {
    track: "h-[var(--control-h-md)] p-1",
    segment: "gap-2 px-[var(--control-px-center-md)] [&_svg:not([class*='size-'])]:size-4",
  },
} as const;

/**
 * Single-select control that switches or filters **one** view: a muted track
 * with the active segment lifted onto the canvas surface.
 *
 * Reach for `Tabs` instead when each choice reveals its own panel of content —
 * that is the tablist/tabpanel contract, and a tablist with no panels behind it
 * misreports the page to assistive tech. This is a radiogroup: Radix supplies
 * the roving focus, arrow-key navigation, and `role="radio"` semantics.
 *
 * Controlled only — `value` and `onValueChange` are both required, so there is
 * no second, uncontrolled code path to reason about.
 *
 * `T` is inferred from `options`/`value`, so a caller with a union-typed filter
 * gets that union back in `onValueChange` — an exhaustive `switch` in the
 * handler typechecks with no cast. It defaults to `string` for callers that
 * have no union to name.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  disabled,
  size = "md",
  "aria-label": ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const s = sizeClasses[size];
  const descriptionId = React.useId();

  return (
    // The provider is the kit's own rather than the host's: the only tooltips
    // it governs are the per-option ones rendered below, so owning it here
    // keeps `title` working without asking every consumer to wrap the control.
    <TooltipProvider>
      <RadioGroupPrimitive.Root
        data-slot="segmented-control"
        data-size={size}
        aria-label={ariaLabel}
        value={value}
        // Radix types its callback against the DOM's bare string; the only
        // values it can hand back are the option values we rendered, which are
        // `T` by construction.
        onValueChange={(next) => onValueChange(next as T)}
        disabled={disabled}
        orientation="horizontal"
        className={cn(
          "inline-flex w-fit items-center rounded-[var(--control-r-md)] bg-muted",
          s.track,
          className,
        )}
      >
        {options.map((option) => {
          const optionDescriptionId = `${descriptionId}-${option.value}`;
          const item = (
            <RadioGroupPrimitive.Item
              key={option.value}
              data-slot="segmented-control-item"
              value={option.value}
              disabled={option.disabled}
              aria-describedby={option.title ? optionDescriptionId : undefined}
              className={cn(
                // Selected styles key on `aria-checked`, not Radix's
                // `data-state`: when an option carries a `title` the item is a
                // `TooltipTrigger asChild`, and the tooltip's own `data-state`
                // (`closed`/`open`) is merged onto the radio *after* Radix's
                // `checked`/`unchecked`, clobbering it. `aria-checked` is the
                // one selection signal the tooltip never touches. (#264)
                "inline-flex h-full items-center justify-center rounded-[var(--control-r-sm)] border border-transparent text-ui whitespace-nowrap text-foreground/60 transition-colors outline-none hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-1 dark:text-muted-foreground dark:hover:text-foreground dark:aria-checked:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
                s.segment,
              )}
            >
              {option.icon}
              {option.label}
            </RadioGroupPrimitive.Item>
          );

          if (!option.title) return item;

          return (
            <React.Fragment key={option.value}>
              <Tooltip>
                <TooltipTrigger asChild>{item}</TooltipTrigger>
                <TooltipContent>{option.title}</TooltipContent>
              </Tooltip>
              {/* The visible tooltip opens on hover and on tab-in focus, but
                  arrow-key focus does not keep it: Radix's radiogroup selects
                  the newly focused segment by synthesizing a click on it, and a
                  click is one of the gestures that dismisses a Radix tooltip.
                  This description is attached unconditionally so a screen
                  reader announces it on every focus regardless — it is the half
                  of `title` that has to survive, and it is what the segment
                  points `aria-describedby` at. */}
              <span id={optionDescriptionId} className="sr-only">
                {option.title}
              </span>
            </React.Fragment>
          );
        })}
      </RadioGroupPrimitive.Root>
    </TooltipProvider>
  );
}
