import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface MessageRowProps {
  /** Avatar (AgentAvatar), at the top of the gutter, or on the name line when
   * the row is narrow. MessageRow sets its size. */
  avatar: ReactNode;
  /** Display name, in small type above the first bubble. */
  name: string;
  /** Compact turn trace, on the name line. */
  subtitle?: ReactNode;
  /** Secondary turn metadata, after the trace on the name line. */
  headerAccessory?: ReactNode;
  /** The turn's bubbles and cards, stacked top to bottom. */
  children?: ReactNode;
  /** Turn actions under the bubbles, outside the avatar's column when there is one. */
  footer?: ReactNode;
  className?: string;
}

/** One agent turn in the transcript, laid out like a group chat: the avatar at
 * the top of the gutter, the name and trace on a small line beside it above the
 * first bubble, and the turn actions below both.
 *
 * A narrow row has no gutter: the avatar shrinks onto the name line, and the
 * bubbles and actions take the full width. The outer element is the query
 * container, so the choice follows the transcript's width in every host. The
 * grid sits one level in because a container query cannot style its own
 * container. */
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
    <div className={cn("@container/message mb-4", className)}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 [grid-template-areas:'avatar_header'_'body_body'_'footer_footer'] @min-[40rem]/message:[grid-template-areas:'avatar_header'_'avatar_body'_'._footer']">
        {/* The slot sizes the avatar: 20px on the name line, 32px in the gutter. */}
        <div className="size-5 self-start [grid-area:avatar] *:size-full @min-[40rem]/message:size-8">
          {avatar}
        </div>
        {/* A fixed height keeps the row on whole pixels: the aux line height alone
            is fractional, and the transcript would carry the fraction into the
            pinned composer. */}
        <div className="flex h-5 min-w-0 items-center gap-2 [grid-area:header] @min-[40rem]/message:pl-3">
          <span className="shrink-0 truncate text-aux text-muted-foreground">{name}</span>
          {subtitle ? <div className="shrink-0">{subtitle}</div> : null}
          {headerAccessory ? (
            <div className="min-w-0 flex-1 overflow-hidden">{headerAccessory}</div>
          ) : null}
        </div>
        {children ? (
          <div className="mt-1 flex min-w-0 flex-col gap-1 [grid-area:body]">{children}</div>
        ) : null}
        {footer ? <div className="min-w-0 [grid-area:footer]">{footer}</div> : null}
      </div>
    </div>
  );
}
