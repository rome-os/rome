import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { RomeLogo } from "@/components/logo";
import { cn } from "@/lib/utils";

interface AgentAvatarProps {
  /** The agent's owning app icon (root-relative `/api/apps/<id>/icon`). When
   * absent or it fails to load, the Rome mark is shown as the fallback. */
  iconUrl?: string | null;
  /** Used for the image alt / accessible name. */
  label?: string | null;
  size?: "default" | "sm" | "lg";
  /** Drawn in place of the Rome mark when there is no icon, for a participant
   * that is not one of Rome's agents, such as an assistant. */
  mark?: ReactNode;
  className?: string;
}

/** Rounded-rectangle avatar for an agent in the chat surface. Shows the agent's
 * app icon, falling back to the Rome mark for core agents or apps that ship no
 * icon. Deliberately a rounded square (not a circle): app icons are authored as
 * square tiles, and circular cropping mangles them. */
export function AgentAvatar({
  iconUrl,
  label,
  size = "default",
  mark,
  className,
}: AgentAvatarProps) {
  return (
    <Avatar size={size} className={cn("rounded-8 after:rounded-8", className)}>
      {iconUrl ? <AvatarImage src={iconUrl} alt={label ?? ""} className="rounded-8" /> : null}
      <AvatarFallback className={cn("rounded-8 bg-surface-muted text-muted-foreground")}>
        {mark ?? <RomeLogo className="h-1/2 w-1/2" aria-hidden />}
      </AvatarFallback>
    </Avatar>
  );
}
