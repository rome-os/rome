import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type KbdProps = ComponentProps<"kbd"> & { variant?: "default" | "ghost" };

export function Kbd({ variant = "default", className, ...props }: KbdProps) {
  if (variant === "ghost") {
    return <kbd {...props} className={cn("font-sans text-aux text-muted-foreground", className)} />;
  }

  return (
    <Badge
      asChild
      variant="muted"
      shape="square"
      className={cn("shrink-0 border-border font-sans font-normal", className)}
    >
      <kbd {...props} />
    </Badge>
  );
}
