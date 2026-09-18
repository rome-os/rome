import { useId, type ComponentProps, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// A chat card whose content opens and closes from a header row. The plan,
// the recap, and a fenced code block are all one of these, so they share one
// frame, one header, and one way of turning the chevron. A card holds one or
// more sections, each with its own header and body, and rules them apart.
//
// The card sits in the message flow, so its border alone says where it ends.
// A cast would lift it off the page it belongs to.
//
// The frame clips rather than scrolls: `overflow-clip` keeps the corners on
// the header's hover tint and on whatever a body paints to its edge, without
// making the card a scroll container. A body that pins something to the top
// of the viewport while the page scrolls, as a code fence pins its copy
// button, would otherwise pin it to the card instead.
export function CollapsibleCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "w-full divide-y divide-border overflow-clip rounded-12 border border-border-strong bg-surface",
        className,
      )}
      {...props}
    />
  );
}

// A row of 32px: the header names what is folded and gets out of the way,
// so it sits a step below the controls around it and the content it opens.
//
// Focus is the design system's outline recipe, inset by one pixel: the row
// fills the card to its clipped edge, so a ring drawn outside the box would
// never be painted. The full recipe is in docs/design-system.md, and
// `outline-solid` is the part that makes it visible at all.
const HEADER_CLASS =
  "flex min-h-8 w-full items-center justify-between gap-3 px-4 py-1 text-left outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-muted/60 focus-visible:bg-surface-muted/60 focus-visible:outline-solid focus-visible:outline-ring/50";

export interface CollapsibleSectionProps extends Omit<ComponentProps<"div">, "title"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the header says, after the chevron. */
  title: ReactNode;
  /** What the header shows at its inline end, if anything. */
  meta?: ReactNode;
  bodyClassName?: string;
  children?: ReactNode;
}

// The header paints no resting fill in either state; the content below says
// which state it is in. The body stays in the tree while closed, hidden, so a
// caller that must unmount its content (a diagram that measures itself on
// mount) does so by withholding children.
export function CollapsibleSection({
  open,
  onOpenChange,
  title,
  meta,
  bodyClassName,
  children,
  ...props
}: CollapsibleSectionProps) {
  const bodyId = useId();
  return (
    <div {...props}>
      <button
        type="button"
        className={HEADER_CLASS}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onOpenChange(!open)}
      >
        {/* A div, not a span: the accessible name joins block children with
            a space, so "Plan In progress" and "1 of 3" read as two things. */}
        <div className="flex min-w-0 items-center gap-2">
          <ChevronRight
            data-collapse-marker
            className={cn(
              "size-3.5 shrink-0 text-subtle-foreground transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-90",
            )}
            aria-hidden
          />
          {title}
        </div>
        {meta}
      </button>
      <div id={bodyId} hidden={!open} className={cn("border-t border-border", bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
