import { ProgressiveBlur } from "@/components/ui/progressive-blur";
import { cn } from "@/lib/utils";

export function ChatEdgeBlur({ edge, className }: { edge: "top" | "bottom"; className?: string }) {
  return (
    <ProgressiveBlur
      direction={edge}
      tint="color-mix(in srgb, var(--chat-canvas) 92%, transparent)"
      className={cn("-z-10", edge === "bottom" && "top-4 max-md:hidden", className)}
    />
  );
}
