import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Wraps a transcript row with a checkbox + full-row click target during share
// selection. The overlay button sits above the row, so in selection mode a
// click toggles the turn instead of activating links/cards underneath.
// `contentClassName` lays out what the row holds, such as a bubble's side.
export function SelectableRow({
  selected,
  onToggle,
  label,
  contentClassName,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  label: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <div data-share-pick className="relative">
      <div
        className={cn(
          "rounded-8 pl-9 transition-colors",
          selected ? "bg-primary/5" : "opacity-60",
          contentClassName,
        )}
      >
        {children}
      </div>
      <span
        className={`pointer-events-none absolute left-2 top-3 flex size-5 items-center justify-center rounded-4 border ${
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-surface"
        }`}
      >
        {selected && <Check className="size-3.5" />}
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={label}
        className="absolute inset-0 rounded-8 ring-primary/40 focus-visible:outline-none focus-visible:ring-2"
      />
    </div>
  );
}
