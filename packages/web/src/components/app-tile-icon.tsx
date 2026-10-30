import { useEffect, useState, type ComponentType } from "react";
import type { InstalledAppCard } from "@rome/api-types/apps";
import { cn } from "@/lib/utils";

// Shared identity bits for app surfaces (apps grid cards + the app details
// page): the tile-shaped icon and the status-dot color mapping.

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export function getStatusDot(status: InstalledAppCard["status"]): string {
  switch (status) {
    case "active":
      return "bg-success";
    case "disabled":
      return "bg-border-strong";
    case "failed":
      return "bg-destructive";
  }
}

// Tile-shaped icon shared by every card.
// - "builtin": render a lucide glyph on a muted surface tile.
// - "image": render the app's self-painted iconUrl (apps own their tile, see
//   rome_apps/coding/src/skills/app_creation/SKILL.md), with a letter avatar
//   fallback.
// `muted` grays the tile out (disabled apps keep their real icon, desaturated).
// `size`: "md" is the inline/header tile; "lg" is the launcher-grid tile.
interface TileIconProps {
  kind: "builtin" | "image";
  displayName: string;
  iconUrl?: string | null;
  BuiltinIcon?: IconComponent;
  muted?: boolean;
  size?: "md" | "lg";
}

const tileSizeClass = {
  md: "h-11 w-11 rounded-12",
  lg: "h-14 w-14 rounded-16 sm:h-16 sm:w-16",
} as const;

export function TileIcon({
  kind,
  displayName,
  iconUrl,
  BuiltinIcon,
  muted,
  size = "md",
}: TileIconProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [iconUrl]);

  const mutedClass = "grayscale opacity-60";
  const sizeClass = tileSizeClass[size];

  if (kind === "builtin" && BuiltinIcon) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center bg-surface-muted text-foreground",
          sizeClass,
          muted && mutedClass,
        )}
      >
        <BuiltinIcon className={size === "lg" ? "h-6 w-6 sm:h-7 sm:w-7" : "h-5 w-5"} aria-hidden />
      </div>
    );
  }
  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt=""
        className={cn(
          "shrink-0 object-cover transition-[filter,opacity] duration-200",
          sizeClass,
          muted && mutedClass,
        )}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center bg-surface-muted text-muted-foreground",
        sizeClass,
        size === "lg" ? "text-title" : "text-ui",
        muted && mutedClass,
      )}
    >
      {displayName.charAt(0).toUpperCase()}
    </div>
  );
}
