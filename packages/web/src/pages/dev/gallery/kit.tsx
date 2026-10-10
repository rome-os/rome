import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One chapter of the gallery. `id` is the anchor the sidebar links to. */
export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mb-4">
        <h2 className="font-serif text-display text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-ui text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * One named component, holding its specimen cards.
 *
 * The `data-gallery-component` attribute is what the sidebar indexes: it walks
 * the rendered DOM to build the component list, so adding a component here puts
 * it in the nav automatically and the two can never disagree.
 */
export function Component({
  id,
  name,
  source,
  children,
}: {
  id: string;
  name: string;
  /**
   * Where the component is authored, as the reader should see it: a path under
   * `src/components` for dashboard-private pieces ("ui/button.tsx"), or the
   * import specifier for kit pieces ("@rome-os/ui/card"). Specimens of both
   * sit side by side here, so the label has to say which is which.
   */
  source: string;
  children: ReactNode;
}) {
  return (
    <div id={id} data-gallery-component={name} className="scroll-mt-20">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-section text-foreground">{name}</h3>
        <code className="font-mono text-aux text-subtle-foreground">{source}</code>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

/**
 * One labelled card holding a set of variants. Sits on `surface` so specimens
 * that use `background` (the segmented control's active segment, say) stay
 * distinguishable from the card they sit on.
 */
export function Specimen({
  label,
  note,
  children,
  className,
}: {
  label: string;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="rounded-12 border border-border bg-surface">
      <div className="border-b border-border-subtle px-4 py-2">
        <p className="text-ui text-foreground">{label}</p>
        {note ? <p className="mt-1 text-aux text-muted-foreground">{note}</p> : null}
      </div>
      <div className={cn("p-4", className)}>{children}</div>
    </div>
  );
}

/** Horizontal run of variants, wrapping on narrow viewports. */
export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-3", className)}>{children}</div>;
}

/** Caption for a single variant inside a Row. */
export function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      {children}
      <span className="text-aux text-subtle-foreground">{label}</span>
    </div>
  );
}
