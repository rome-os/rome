import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The stop glyph: the solid square the chat composer's Stop button draws. It
 * takes the text colour unless the caller names another fill.
 */
export function StopGlyph({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2.5 bg-current", className)}
      {...rest}
    />
  );
}
