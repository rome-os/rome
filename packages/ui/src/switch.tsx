import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "./cn.js";

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // Geometry is two numbers per size — track width and thumb diameter —
        // plus one shared inset. Track height and thumb travel derive from them,
        // so the gap above the thumb and the gap beside it cannot drift apart,
        // and changing any one number keeps the rest correct. The thumb is
        // placed by transform rather than by padding on the track: a 1px inset
        // is not a step on the spacing scale, and it is geometry rather than
        // spacing.
        "peer group/switch relative inline-flex h-[var(--switch-h)] w-[var(--switch-w)] shrink-0 items-center rounded-full transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 touch:after:inset-x-0",
        "[--switch-inset:1px] [--switch-h:calc(var(--switch-thumb)_+_2_*_var(--switch-inset))] [--switch-travel:calc(var(--switch-w)_-_var(--switch-inset)_-_var(--switch-thumb))]",
        "data-[size=default]:[--switch-thumb:1rem] data-[size=default]:[--switch-w:2rem]",
        "data-[size=sm]:[--switch-thumb:0.75rem] data-[size=sm]:[--switch-w:1.5rem]",
        // Both sizes share the touch geometry. Attribute specificity matches
        // the desktop size rules, so the media variant can override them. It is
        // already wider than the floor, so its `after:` inset keeps only the
        // 8px above and below that make the target 44px tall. The 12px to each
        // side would take taps on a control 8px away.
        "touch:data-[size]:[--switch-thumb:1.625rem] touch:data-[size]:[--switch-w:3rem]",
        "outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50 aria-invalid:outline-solid aria-invalid:outline-2 aria-invalid:outline-offset-0 aria-invalid:outline-destructive",
        "data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[var(--switch-thumb)] rounded-full bg-background transition-transform data-checked:translate-x-[var(--switch-travel)] dark:data-checked:bg-primary-foreground data-unchecked:translate-x-[var(--switch-inset)] dark:data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
