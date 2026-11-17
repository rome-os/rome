import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { OTPInput, OTPInputContext } from "input-otp";

import { cn } from "./cn.js";

export { REGEXP_ONLY_DIGITS } from "input-otp";

// shadcn InputOTP (input-otp) rewired to the kit's tokens: separate, slightly
// tall slots with a hairline border and the Input's own fill. The active slot
// takes the kit's focus outline. An invalid slot takes a 1px destructive edge,
// lighter than Input's 2px one, since six red frames in a row read as a block of
// colour. The real <input>
// sits invisibly over the slots, so paste, autofill and the mobile keypad work.

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput>) {
  return (
    <OTPInput
      data-slot="input-otp"
      // The default widens the field past the last slot to clear a password
      // manager's badge. The slots are the whole visible control, so the kit
      // keeps the width fixed.
      pushPasswordManagerStrategy="none"
      containerClassName={cn("flex items-center gap-2 has-disabled:opacity-50", containerClassName)}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn("flex min-w-0 items-center gap-2", className)}
      {...props}
    />
  );
}

// The slots may shrink below their width, so six of them and a trailing button
// still fit a narrow column. The border width is unconditional and only its
// color changes, like `Input`. A filled slot takes the stronger edge, which is
// how the row shows its progress.
const slotVariants = cva(
  "relative flex min-w-0 items-center justify-center border border-input bg-transparent text-title tabular-nums transition-colors outline-none outline-1 -outline-offset-1 outline-transparent data-[active=true]:outline-solid data-[active=true]:outline-ring/50 data-[filled=true]:border-border-strong aria-invalid:outline-solid aria-invalid:outline-destructive/60 dark:bg-input/30",
  {
    variants: {
      size: {
        sm: "h-[var(--rome-size-44)] w-[var(--rome-size-36)] rounded-[var(--control-r-sm)]",
        md: "h-[calc(var(--rome-size-44)+var(--rome-size-8))] w-[var(--rome-size-44)] rounded-[var(--control-r-md)]",
      },
    },
    defaultVariants: { size: "md" },
  },
);

type InputOTPSlotProps = React.ComponentProps<"div"> &
  VariantProps<typeof slotVariants> & {
    index: number;
    /** Draws a filled circle in place of the character. */
    masked?: boolean;
    /** Marks the slot invalid with a thin destructive edge. */
    invalid?: boolean;
  };

function InputOTPSlot({
  index,
  size = "md",
  masked = false,
  invalid = false,
  className,
  ...props
}: InputOTPSlotProps) {
  const { char, hasFakeCaret, isActive } = React.useContext(OTPInputContext).slots[index] ?? {};
  return (
    <div
      data-slot="input-otp-slot"
      data-size={size}
      data-active={isActive}
      data-filled={Boolean(char)}
      aria-invalid={invalid || undefined}
      className={cn(slotVariants({ size }), className)}
      {...props}
    >
      {char &&
        (masked ? (
          <span
            data-slot="input-otp-dot"
            aria-hidden
            className="size-2 rounded-full bg-foreground"
          />
        ) : (
          char
        ))}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-0.5 animate-pulse bg-foreground" />
        </div>
      )}
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot };
