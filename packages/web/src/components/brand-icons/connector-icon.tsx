import { cn } from "@/lib/utils";
import { ComposioServiceBadge, hasComposioGlyph } from "./composio-glyphs";
import { ConnectionBrandBadge, hasConnectionBrand } from "./connection-badges";

/**
 * The mark of a service the Concierge lists, from the id its connector entry
 * carries: `brand:<connection kind>` for Rome's own connections (the badges
 * Settings → Connections draws), `glyph:<id>` for a provider's glyph. A service
 * with no id, or one this build does not draw, gets a neutral tile with its
 * initial, the same size as those badges.
 */
export function ConnectorIcon({
  icon,
  label,
  className,
}: {
  icon: string | null | undefined;
  label: string;
  className?: string;
}) {
  const at = icon?.indexOf(":") ?? -1;
  const source = icon && at > 0 ? icon.slice(0, at) : null;
  const id = icon && at > 0 ? icon.slice(at + 1) : "";
  if (source === "brand" && hasConnectionBrand(id)) {
    return <ConnectionBrandBadge connection={id} className={className} />;
  }
  if (source === "glyph" && hasComposioGlyph(id)) {
    return <ComposioServiceBadge glyph={id} className={className} />;
  }
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-8 border border-border bg-surface text-ui font-medium text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      {label.trim().charAt(0).toUpperCase()}
    </div>
  );
}
