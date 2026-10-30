import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// A tiny content-teleport primitive: a named region a layout renders once
// (`<SlotOutlet>`, the moral twin of react-router's `<Outlet>`) that any
// descendant fills from afar (`<SlotContent>`). Unlike `<Outlet>` — which flows
// parent → child — this carries rendered nodes child → parent, the one direction
// the router can't. Internally it's a portal; the ref/occupancy bookkeeping that
// makes it declarative lives here so call sites stay free of it.

type SlotRegistry = {
  hosts: Record<string, HTMLElement | null>;
  fills: Record<string, number>;
  setHost: (name: string, el: HTMLElement | null) => void;
  addFill: (name: string) => void;
  removeFill: (name: string) => void;
};

const SlotContext = createContext<SlotRegistry | null>(null);

function useSlotRegistry(): SlotRegistry {
  const registry = useContext(SlotContext);
  if (!registry) {
    throw new Error("Slot components must be rendered within a <SlotProvider>");
  }
  return registry;
}

/** Wrap the app once so outlets and their fillers share a registry. */
export function SlotProvider({ children }: { children: ReactNode }) {
  const [hosts, setHosts] = useState<Record<string, HTMLElement | null>>({});
  const [fills, setFills] = useState<Record<string, number>>({});

  // Stable mutators (functional updates, no captured state) so a filler's
  // mount/unmount effect runs exactly once per lifetime, never on every render.
  const mutators = useMemo(
    () => ({
      setHost: (name: string, el: HTMLElement | null) =>
        setHosts((prev) => (prev[name] === el ? prev : { ...prev, [name]: el })),
      addFill: (name: string) => setFills((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 })),
      removeFill: (name: string) =>
        setFills((prev) => ({ ...prev, [name]: Math.max(0, (prev[name] ?? 0) - 1) })),
    }),
    [],
  );

  const value = useMemo<SlotRegistry>(
    () => ({ hosts, fills, ...mutators }),
    [hosts, fills, mutators],
  );

  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>;
}

/**
 * The layout-side anchor — renders a host element and shows `fallback` until a
 * `<SlotContent name=...>` for the same name mounts. `className` styles the host.
 */
export function SlotOutlet({
  name,
  fallback,
  className,
}: {
  name: string;
  fallback?: ReactNode;
  className?: string;
}) {
  const { setHost, fills } = useSlotRegistry();
  const ref = useCallback((el: HTMLElement | null) => setHost(name, el), [name, setHost]);
  const filled = (fills[name] ?? 0) > 0;
  return (
    <div ref={ref} className={className}>
      {filled ? null : fallback}
    </div>
  );
}

/**
 * Whether an outlet named `name` is on the page, for a filler with a fallback.
 * Without a provider there is no outlet, so a page rendered on its own draws
 * the fallback rather than throwing.
 */
export function useSlotOutlet(name: string): boolean {
  const registry = useContext(SlotContext);
  return (registry?.hosts[name] ?? null) !== null;
}

/**
 * The page-side filler — portals `children` into the matching outlet.
 *
 * `hideWithPage` is for a page an `<Activity>` can hide. The outlet is outside
 * the page, and in the browser the page's hidden state does not reach what it
 * portals out (the kept Concierge's header would sit beside the visible chat's),
 * so the filler hides its own content: the layout cleanup runs as the page is
 * hidden, and the layout effect as it is shown again. The content sits in a
 * wrapper that keeps out of the outlet's layout (`display: contents`).
 */
export function SlotContent({
  name,
  children,
  hideWithPage = false,
}: {
  name: string;
  children: ReactNode;
  hideWithPage?: boolean;
}) {
  const { hosts, addFill, removeFill } = useSlotRegistry();
  const host = hosts[name] ?? null;
  useEffect(() => {
    addFill(name);
    return () => removeFill(name);
  }, [name, addFill, removeFill]);
  const wrapper = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = wrapper.current;
    if (!hideWithPage || !node) return;
    node.style.display = "contents";
    return () => {
      node.style.display = "none";
    };
  }, [hideWithPage, host]);
  if (!host) return null;
  return createPortal(
    hideWithPage ? (
      <div ref={wrapper} style={{ display: "contents" }}>
        {children}
      </div>
    ) : (
      children
    ),
    host,
  );
}
