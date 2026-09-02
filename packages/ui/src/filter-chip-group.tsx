import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

import { cn } from "./cn.js";

export type FilterChipOption<T extends string = string> = {
  value: T;
  label: React.ReactNode;
  /**
   * How many rows this choice matches, shown after the label. It is the only
   * report of the filter's reach, so it is paint-critical: on the selected
   * chip it takes the chip's own `--primary-foreground` rather than the quiet
   * `--subtle-foreground`, which is a light-surface value and disappears on
   * the `--primary` fill.
   */
  count?: number;
  /**
   * Pushes this chip, and any after it, to the far end of the rail. For an
   * option the rest are not peers of — a queue waiting on a decision beside a
   * set of settled categories — so the gap carries that. Once the row is wide
   * enough to scroll there is no slack left to push into, and the chip sits
   * against its neighbor like any other.
   */
  alignEnd?: boolean;
  disabled?: boolean;
};

export interface FilterChipGroupProps<T extends string = string> {
  options: FilterChipOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Disables every chip; OR'd with each option's own `disabled`. */
  disabled?: boolean;
  /** Required: a radiogroup with no accessible name is unusable by screen reader. */
  "aria-label": string;
  className?: string;
}

/**
 * Single-select filter over a list, as a scrolling row of pill chips that each
 * carry a count.
 *
 * Reach for `SegmentedControl` instead when the choice switches between a few
 * fixed views: it is a fixed-width track, and it is the default answer for
 * one-of-N. This is the other shape — a data-driven option set that can grow
 * past the width of its container and scrolls rather than compressing, sitting
 * above the rows it filters. Both are radiogroups, so neither tells assistive
 * tech to look for panels that do not exist.
 *
 * Controlled only — `value` and `onValueChange` are both required, so there is
 * no second, uncontrolled code path to reason about.
 *
 * `T` is inferred from `options`/`value`, so a caller with a union-typed filter
 * gets that union back in `onValueChange` — an exhaustive `switch` in the
 * handler typechecks with no cast. It defaults to `string` for callers that
 * have no union to name.
 */
export function FilterChipGroup<T extends string = string>({
  options,
  value,
  onValueChange,
  disabled,
  "aria-label": ariaLabel,
  className,
}: FilterChipGroupProps<T>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="filter-chip-group"
      aria-label={ariaLabel}
      value={value}
      // Radix types its callback against the DOM's bare string; the only
      // values it can hand back are the option values we rendered, which are
      // `T` by construction.
      onValueChange={(next) => onValueChange(next as T)}
      disabled={disabled}
      orientation="horizontal"
      // The row scrolls, so it insets by one step and pulls the same step back
      // out: without the inset a focused chip's outline is clipped at the
      // scroll edge, and without the negative margin that inset would shift
      // the row off the column its heading sits on.
      className={cn("-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1", className)}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <RadioGroupPrimitive.Item
            key={option.value}
            data-slot="filter-chip"
            value={option.value}
            disabled={option.disabled}
            // The border width is unconditional and only its color changes:
            // toggling a width would resize the chip on selection and shunt
            // every chip after it sideways.
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-badge transition-colors outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
              option.alignEnd && "ml-auto",
              checked
                ? "border-transparent bg-primary text-primary-foreground"
                : "border-border-strong bg-surface text-foreground hover:bg-surface-muted",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span
                data-slot="filter-chip-count"
                className={cn(
                  "ml-2 tabular-nums",
                  checked ? "text-primary-foreground" : "text-subtle-foreground",
                )}
              >
                {option.count}
              </span>
            )}
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}
