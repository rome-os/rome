import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// Default body padding follows the trace's scale-safe compact rhythm
// (4px top, 0 right, 4px bottom, 8px left). Consumers that wrap something
// other than a tool group (e.g. a session card) can override.
const DEFAULT_BODY_CLASS = "pt-1 pr-0 pb-1 pl-2";

export function CollapsibleTraceRow({
  icon,
  label,
  labelSuffix,
  meta,
  defaultOpen = false,
  bodyClassName = DEFAULT_BODY_CLASS,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  /** Optional inline element rendered immediately after the label, before
   *  the flex spacer that pushes `meta` to the right. */
  labelSuffix?: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full select-text items-center gap-2 rounded-8 px-2 py-2 text-left text-ui text-foreground hover:bg-surface-muted"
      >
        <span className="inline-flex h-[22px] w-[22px] flex-none items-center justify-center rounded-8 bg-surface text-badge text-muted-foreground ring-1 ring-border">
          {icon}
        </span>
        <span className="min-w-0 truncate text-foreground">{label}</span>
        {labelSuffix}
        <span className="flex-1" />
        {meta}
        <span className="flex-none text-subtle-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>
      {open && <div className={bodyClassName}>{children}</div>}
    </div>
  );
}
