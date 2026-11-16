import type { ComponentProps, CSSProperties } from "react";
import { cn } from "./cn.js";

export interface ProgressiveBlurProps extends Omit<ComponentProps<"div">, "children"> {
  /** The edge where the blur is strongest. */
  direction?: "top" | "bottom" | "left" | "right";
  /** Maximum blur radius in pixels. */
  maxBlur?: number;
  /** Optional CSS color that fades in toward the blurred edge. */
  tint?: string;
}

/** Mount above the content to blur and below the controls that must stay sharp. */
export function ProgressiveBlur({
  direction = "top",
  maxBlur = 16,
  tint,
  className,
  ...props
}: ProgressiveBlurProps) {
  const layerStyle: CSSProperties = { position: "absolute", inset: 0 };
  return (
    <div
      {...props}
      data-slot="progressive-blur"
      aria-hidden
      className={cn("pointer-events-none absolute inset-0", className)}
    >
      {/* Masks stay on sibling layers so each can sample the backdrop. */}
      {[0.125, 0.25, 0.5, 1].map((scale, index) => {
        const blur = `blur(${Math.max(0, maxBlur) * scale}px)`;
        const mask = `linear-gradient(to ${direction}, transparent ${index * 25}%, black ${(index + 1) * 25}%)`;
        return (
          <span
            key={scale}
            style={{
              ...layerStyle,
              WebkitBackdropFilter: blur,
              backdropFilter: blur,
              WebkitMaskImage: mask,
              maskImage: mask,
            }}
          />
        );
      })}
      {tint ? (
        <span
          style={{
            ...layerStyle,
            background: `linear-gradient(to ${direction}, transparent, ${tint})`,
          }}
        />
      ) : null}
    </div>
  );
}
