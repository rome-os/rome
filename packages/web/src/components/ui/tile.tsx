import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TileProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  selected?: boolean;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
}

export const Tile = forwardRef<HTMLButtonElement, TileProps>(function Tile(
  { selected = false, icon, title, description, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={cn(
        "flex flex-col items-start gap-1 rounded-8 border p-3 text-left transition outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50",
        selected
          ? "border-brand bg-brand/5 ring-1 ring-brand"
          : "border-border-strong bg-surface hover:bg-surface-muted",
        className,
      )}
      {...rest}
    >
      <div className="flex items-center gap-2">
        {icon && <span className={selected ? "text-brand" : "text-foreground"}>{icon}</span>}
        <span className="text-ui text-foreground">{title}</span>
      </div>
      {description && <span className="text-aux text-muted-foreground">{description}</span>}
    </button>
  );
});
