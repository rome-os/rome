import { ChevronDown } from "lucide-react";

interface SidebarDisclosureProps {
  expanded: boolean;
  onToggle: () => void;
  /** Id of the list the divider reveals, while that list is in the DOM. */
  controls?: string;
  /** What the toggle does in each state. The sidebar can show two folds at
   * once, so each names its own rows rather than a bare "Show more". */
  showLabel: string;
  hideLabel: string;
}

// A divider that doubles as the toggle for the rows it folds: a sidebar zone
// that folds spends no row of its own on a "Show more" label. It sits under the
// zone, so opening it drops the divider below the revealed rows, and the whole
// line is the hit target, not only the chevron. On touch it grows to the
// comfortable control height, with the line still centered.
export function SidebarDisclosure({
  expanded,
  onToggle,
  controls,
  showLabel,
  hideLabel,
}: SidebarDisclosureProps) {
  const label = expanded ? hideLabel : showLabel;
  return (
    <div className="px-3">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onToggle}
        className="group/disclosure flex h-6 min-h-[var(--control-min-h)] w-full items-center gap-1 rounded-8 px-2 text-subtle-foreground outline-none outline-1 outline-offset-0 outline-transparent transition hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        <span className="flex-1 border-t border-border-subtle transition group-hover/disclosure:border-border" />
        {/* The chevron reads as the control: it takes a button's hover fill
            while the line around it only darkens. */}
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-[var(--control-r-sm)] transition group-hover/disclosure:bg-surface-hover group-focus-visible/disclosure:bg-surface-hover"
        >
          <ChevronDown
            className={`size-3.5 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
          />
        </span>
        <span className="flex-1 border-t border-border-subtle transition group-hover/disclosure:border-border" />
      </button>
    </div>
  );
}

// The plain divider between sidebar sections, sized to sit level with a
// SidebarDisclosure so the two read as one rule.
export function SidebarDivider() {
  return (
    <div className="flex h-6 items-center px-5" aria-hidden>
      <span className="flex-1 border-t border-border-subtle" />
    </div>
  );
}
