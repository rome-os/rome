import { ProgressiveBlur } from "@/components/ui/progressive-blur";
import { cn } from "@/lib/utils";

export function ChatEdgeBlur({
  edge,
  className,
  covers,
}: {
  edge: "top" | "bottom";
  className?: string;
  /**
   * For a header with content over it: the edge takes the canvas colour in full
   * where that content sits, then fades out below it, so nothing scrolling under
   * shows through. The blur keeps its look beyond it.
   */
  covers?: boolean;
}) {
  return (
    <>
      <ProgressiveBlur
        direction={edge}
        tint="color-mix(in srgb, var(--chat-canvas) 92%, transparent)"
        className={cn(
          "-z-10",
          edge === "bottom" && "top-4 max-md:hidden",
          covers && edge === "top" && "-bottom-4",
          className,
        )}
      />
      {covers && edge === "top" ? (
        <div
          aria-hidden
          data-edge-cover
          className="pointer-events-none absolute inset-x-0 top-0 -bottom-4 -z-10 bg-[linear-gradient(to_bottom,var(--chat-canvas)_0%,var(--chat-canvas)_70%,transparent_100%)]"
        />
      ) : null}
    </>
  );
}
