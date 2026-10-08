import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface MessageRowProps {
  /** Avatar (AgentAvatar), beside the last bubble. */
  avatar: ReactNode;
  /** Display name, in small type above the first bubble. */
  name: string;
  /** Compact turn trace, on the name line. */
  subtitle?: ReactNode;
  /** Secondary turn metadata, after the trace on the name line. */
  headerAccessory?: ReactNode;
  /** The turn's bubbles and cards, stacked top to bottom. */
  children?: ReactNode;
  /** Turn actions under the bubbles, outside the avatar's column. */
  footer?: ReactNode;
  className?: string;
}

/** One agent turn in the transcript, laid out like a group chat: the name and
 * trace on a small line above the first bubble, the avatar at the bottom of
 * the gutter beside the last bubble, and the turn actions below both. */
export function MessageRow({
  avatar,
  name,
  subtitle,
  headerAccessory,
  children,
  footer,
  className,
}: MessageRowProps) {
  return (
    <div className={cn("mb-4", className)}>
      <div className="flex items-end gap-2">
        <div className="shrink-0">{avatar}</div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 pl-3">
            <span className="shrink-0 truncate text-aux text-muted-foreground">{name}</span>
            {subtitle ? <div className="shrink-0">{subtitle}</div> : null}
            {headerAccessory ? (
              <div className="min-w-0 flex-1 overflow-hidden">{headerAccessory}</div>
            ) : null}
          </div>
          {children ? <div className="mt-1 flex flex-col gap-1">{children}</div> : null}
        </div>
      </div>
      {/* Indent past the avatar (size-8) and gap-2 so actions align under the bubbles. */}
      {footer ? <div className="pl-10">{footer}</div> : null}
    </div>
  );
}
