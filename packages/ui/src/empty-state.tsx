import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "./cn.js";

interface EmptyStateContextValue {
  titleId: string;
  descriptionId: string;
  registerTitle: (id: string) => () => void;
  registerDescription: (id: string) => () => void;
}

const EmptyStateContext = createContext<EmptyStateContextValue | null>(null);

export interface EmptyStateProps extends ComponentProps<"div"> {
  children?: ReactNode;
}

/**
 * A terminal empty, loading, or no-results panel. The component owns a useful
 * intrinsic height; callers that own a taller box can add `h-full` without
 * changing the composition inside it.
 *
 * Loading is deliberately composition rather than a variant: put a Spinner in
 * EmptyStateIcon so the same anatomy explains both waiting and nothing-found
 * states without a boolean prop swapping content behind the caller's back.
 */
export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  {
    className,
    children,
    role = "status",
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    ...props
  },
  ref,
) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const [renderedTitleId, setRenderedTitleId] = useState<string>();
  const [renderedDescriptionId, setRenderedDescriptionId] = useState<string>();
  const registerTitle = useCallback((nextId: string) => {
    setRenderedTitleId(nextId);
    return () => setRenderedTitleId((currentId) => (currentId === nextId ? undefined : currentId));
  }, []);
  const registerDescription = useCallback((nextId: string) => {
    setRenderedDescriptionId(nextId);
    return () =>
      setRenderedDescriptionId((currentId) => (currentId === nextId ? undefined : currentId));
  }, []);

  return (
    <EmptyStateContext.Provider
      value={{ titleId, descriptionId, registerTitle, registerDescription }}
    >
      <div
        ref={ref}
        data-slot="empty-state"
        role={role}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? ariaLabelledBy : (ariaLabelledBy ?? renderedTitleId)}
        aria-describedby={ariaDescribedBy ?? renderedDescriptionId}
        className={cn("grid min-h-48 place-items-center px-6 py-10 text-center", className)}
        {...props}
      >
        <div data-slot="empty-state-content" className="flex w-full max-w-sm flex-col items-center">
          {children}
        </div>
      </div>
    </EmptyStateContext.Provider>
  );
});

export function EmptyStateIcon({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-icon"
      className={cn(
        // 20px, with no `:not([class*='size-'])` opt-out, unlike the glyph
        // rules on Button and IconButton. The tile normalizes whatever it holds
        // rather than defaulting it: a Spinner tops out at the 16px `md` step,
        // so letting it keep its own size would leave the waiting tile visibly
        // smaller than the nothing-found tile it is meant to be interchangeable
        // with. A caller who wants another size resizes the tile.
        "mb-3 flex size-11 shrink-0 items-center justify-center rounded-12 bg-surface-muted text-muted-foreground [&_svg]:size-5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyStateTitle({ id, className, ...props }: ComponentProps<"h3">) {
  const context = useContext(EmptyStateContext);
  const effectiveId = id ?? context?.titleId;
  const registerTitle = context?.registerTitle;

  useLayoutEffect(() => {
    if (!registerTitle || !effectiveId) return;
    return registerTitle(effectiveId);
  }, [registerTitle, effectiveId]);

  return (
    <h3
      id={effectiveId}
      data-slot="empty-state-title"
      // Section, not Title: the panel sits inside a page or card beside alerts
      // and rows, and its heading reads at their scale.
      className={cn("text-section text-foreground", className)}
      {...props}
    />
  );
}

export function EmptyStateDescription({ id, className, ...props }: ComponentProps<"p">) {
  const context = useContext(EmptyStateContext);
  const effectiveId = id ?? context?.descriptionId;
  const registerDescription = context?.registerDescription;

  useLayoutEffect(() => {
    if (!registerDescription || !effectiveId) return;
    return registerDescription(effectiveId);
  }, [registerDescription, effectiveId]);

  return (
    <p
      id={effectiveId}
      data-slot="empty-state-description"
      className={cn("mt-1 text-ui text-muted-foreground", className)}
      {...props}
    />
  );
}

export function EmptyStateAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-action"
      className={cn("mt-4 flex items-center justify-center gap-2", className)}
      {...props}
    />
  );
}
