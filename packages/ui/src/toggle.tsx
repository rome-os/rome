import type { ComponentProps } from "react";
import type { VariantProps } from "class-variance-authority";

import { buttonVariants } from "./button.js";
import { cn } from "./cn.js";
import { canonicalControlSize } from "./control-size.js";

/** The *unpressed* resting look. Both mirror `Button`'s variant of the same name. */
type ToggleVariant = "ghost" | "outline";

/**
 * Button's own size vocabulary, read off `buttonVariants` rather than restated,
 * so a toggle and a button on one toolbar row cannot drift apart — and a size
 * added to `Button` is a size `Toggle` already has.
 */
type ToggleSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export interface ToggleProps
  extends Omit<ComponentProps<"button">, "aria-pressed" | "onClick" | "type"> {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  variant?: ToggleVariant;
  size?: ToggleSize;
}

/**
 * The pressed paint, shared by every variant: which fill means "on" is the
 * component's decision, not the caller's.
 *
 * `primary` at low alpha is the design system's highlight. A solid `primary`
 * would read as the screen's one CTA, and `secondary` resolves to the same
 * neutral step as `ghost`'s hover fill — a pressed toggle would be
 * indistinguishable from a merely hovered one.
 *
 * Every modifier chain the resting variants paint a background or text color
 * under is answered here — bare, `hover:`, `dark:`, `dark:hover:` — because
 * `cn` (tailwind-merge) resolves a collision only between classes carrying the
 * *same* modifiers. Leave `dark:hover:bg-input/50` uncontested and stylesheet
 * order, not this string, decides what a hovered pressed toggle looks like in
 * dark mode.
 */
const pressedClasses =
  "bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary dark:bg-primary/20 dark:hover:bg-primary/30";

/**
 * A button that stays pressed — the on/off control for a toolbar row.
 *
 * Reach for `Switch` instead when the control is a setting in a form: a switch
 * carries the "this is a value you are editing" reading, and it does not sit
 * correctly among toolbar buttons. Reach for `SegmentedControl` when the user
 * picks one of N; this is one independent on/off.
 *
 * Controlled only — `pressed` and `onPressedChange` are both required, so there
 * is no second, uncontrolled code path to reason about (the `SegmentedControl`
 * precedent).
 *
 * A plain `<button>` rather than `@radix-ui/react-toggle`: with the uncontrolled
 * path gone and `aria-pressed` owned here, the primitive would contribute a
 * dependency and nothing else.
 */
export function Toggle({
  pressed,
  onPressedChange,
  variant = "ghost",
  size = "md",
  className,
  ...rest
}: ToggleProps) {
  return (
    <button
      type="button"
      data-slot="toggle"
      data-size={canonicalControlSize(size)}
      className={cn(buttonVariants({ variant, size }), pressed && pressedClasses, className)}
      onClick={() => onPressedChange(!pressed)}
      {...rest}
      // After the spread on purpose. The props type already refuses
      // `aria-pressed`; this is the runtime half of the same guarantee, so the
      // accessible state can never disagree with the paint above it.
      aria-pressed={pressed}
    />
  );
}
