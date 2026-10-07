import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "./cn.js";

/*
 * The page frame and the section rhythm every layout in the catalogue composes.
 * The catalogue, the slot tables, and the responsive behaviour are in
 * docs/ui/layouts.md.
 *
 * No part here renders `main`. The dashboard shell owns the one `main`
 * landmark, and a second one nested inside it breaks landmark navigation for a
 * screen reader. A layout reaches for `div`, `section`, `header`, `aside`, or
 * `nav` instead.
 *
 * The frame is full-bleed: it fills the column beside the nav and centers
 * nothing. A page that needs a reading measure constrains itself below the
 * header through `Measure`, so the `h1` sits at the same spot on every route.
 */

type TopBarRegion = "nav" | "title" | "action" | "edge";
type TopBarHosts = Record<TopBarRegion, HTMLElement | null>;

interface TopBarRegistry {
  hosts: TopBarHosts;
  /** The claim ids of mounted headers, oldest first. The newest one fills the bar. */
  claims: string[];
  setHost: (region: TopBarRegion, el: HTMLElement | null) => void;
  claim: (id: string) => void;
  release: (id: string) => void;
}

const TopBarContext = createContext<TopBarRegistry | null>(null);

/**
 * The bar's hosts, handed only to the parts of the header that owns the bar,
 * and only below `md`. A part renders in exactly one place: the bar while this
 * is set, the page otherwise.
 */
const HeaderTopBarContext = createContext<TopBarHosts | null>(null);

const NO_HOSTS: TopBarHosts = { nav: null, title: null, action: null, edge: null };

/** Below Tailwind's `md`, the width the shell shows its phone top bar at. */
const PHONE_QUERY = "(max-width: 47.99rem)";

function subscribePhone(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isPhone = () => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_QUERY).matches;
const notPhone = () => false;
const noSubscription = () => () => {};

function usePhone(): boolean {
  return useSyncExternalStore(
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? subscribePhone
      : noSubscription,
    isPhone,
    notPhone,
  );
}

/**
 * Lets a `PageHeader` below it fill a `PageTopBarOutlet` the shell renders
 * elsewhere, the way a phone app's navigation bar names the screen under it.
 * Without a provider, while no outlet is mounted, or at `md` and wider, every
 * part renders only in the page, as it would anywhere else.
 */
export function PageTopBarProvider({ children }: { children: ReactNode }) {
  const [hosts, setHosts] = useState<TopBarHosts>(NO_HOSTS);
  const [claims, setClaims] = useState<string[]>([]);
  const mutators = useMemo(
    () => ({
      setHost: (region: TopBarRegion, el: HTMLElement | null) =>
        setHosts((prev) => (prev[region] === el ? prev : { ...prev, [region]: el })),
      claim: (id: string) => setClaims((prev) => [...prev, id]),
      release: (id: string) => setClaims((prev) => prev.filter((claimed) => claimed !== id)),
    }),
    [],
  );
  const value = useMemo(() => ({ hosts, claims, ...mutators }), [hosts, claims, mutators]);
  return <TopBarContext.Provider value={value}>{children}</TopBarContext.Provider>;
}

/**
 * The phone top bar's content row: the back link, the title, and one action, in
 * that order. Shows `fallback` while no `PageHeader` holds the bar.
 *
 * Render it inside the bar's `header`. That element's bottom edge is where the
 * page's `h1` counts as scrolled under the bar, and the outlet's own box when no
 * `header` encloses it.
 */
export function PageTopBarOutlet({
  className,
  fallback,
}: {
  className?: string;
  fallback?: ReactNode;
}) {
  const registry = useContext(TopBarContext);
  const setHost = registry?.setHost;
  const setRoot = useCallback(
    (el: HTMLElement | null) => setHost?.("edge", el?.closest("header") ?? el),
    [setHost],
  );
  const setNav = useCallback((el: HTMLElement | null) => setHost?.("nav", el), [setHost]);
  const setTitle = useCallback((el: HTMLElement | null) => setHost?.("title", el), [setHost]);
  const setAction = useCallback((el: HTMLElement | null) => setHost?.("action", el), [setHost]);
  const held = (registry?.claims.length ?? 0) > 0;
  return (
    <div
      ref={setRoot}
      data-slot="page-top-bar"
      className={cn("flex min-w-0 items-center gap-2", className)}
    >
      {held ? null : fallback}
      <div ref={setNav} className="flex shrink-0 items-center empty:hidden" />
      <div
        ref={setTitle}
        className={cn(
          "min-w-0 flex-1 truncate text-ui font-medium text-foreground",
          !held && "hidden",
        )}
      />
      <div ref={setAction} className="flex shrink-0 items-center empty:hidden" />
    </div>
  );
}

/**
 * Claims the bar for one header. Returns its hosts while that header is the
 * newest claim and the viewport is below `md`, and null otherwise.
 */
function useTopBarClaim(): TopBarHosts | null {
  const registry = useContext(TopBarContext);
  const phone = usePhone();
  const id = useId();
  const claim = registry?.claim;
  const release = registry?.release;
  useEffect(() => {
    if (!claim || !release) return;
    claim(id);
    return () => release(id);
  }, [id, claim, release]);
  if (!phone || !registry || registry.claims.at(-1) !== id) return null;
  return registry.hosts;
}

/** Whether the element's bottom edge has scrolled up to or past the edge's bottom. */
function useScrolledUnder(target: HTMLElement | null, edge: HTMLElement | null): boolean {
  const [under, setUnder] = useState(false);
  useEffect(() => {
    if (!target || !edge) {
      setUnder(false);
      return;
    }
    // Both boxes are read on every check rather than once, so a bar that
    // changes height, or a viewport that crosses `md`, never leaves a stale
    // boundary behind. Capture catches a scroll on any ancestor, not only the
    // document.
    let frame = 0;
    const check = () => {
      frame = 0;
      setUnder(target.getBoundingClientRect().bottom <= edge.getBoundingClientRect().bottom);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [target, edge]);
  return under;
}

/**
 * Renders `element` once into a node it owns, and attaches that node to `host`
 * when given and to an inline placeholder otherwise. The portal target never
 * changes, so moving between the page and the bar keeps the subtree's state.
 * Focus inside the subtree is restored after a move, since a browser blurs a
 * node it reparents or stops rendering.
 *
 * The placeholder and the owned node both render as `display: contents`, so
 * `element` lays out as if it sat where the placeholder does.
 */
function useRelocated(element: ReactNode, host: HTMLElement | null) {
  // Without a provider the part has nowhere to move, so it renders inline as
  // plain markup, which also keeps it renderable on a server.
  const relocatable = useContext(TopBarContext) !== null && typeof document !== "undefined";
  const [owned] = useState(() => {
    if (!relocatable) return null;
    const el = document.createElement("div");
    el.style.display = "contents";
    // The last control focused inside the node. A browser drops focus from a
    // control that stops rendering, as the bar's does when the viewport
    // crosses `md`, and that blur names no next target. A blur that names one
    // is the user moving on, so it clears the record.
    const record: { last: HTMLElement | null } = { last: null };
    el.addEventListener("focusin", (event) => {
      record.last = event.target instanceof HTMLElement ? event.target : null;
    });
    el.addEventListener("focusout", (event) => {
      if (event.relatedTarget !== null) record.last = null;
    });
    return { node: el, focus: record };
  });
  const node = owned?.node ?? null;
  const focus = owned?.focus ?? null;
  // A ref callback rather than an effect, so the node is in the document
  // before the subtree's own layout effects measure it.
  const placeholder = useCallback(
    (inline: HTMLElement | null) => {
      // A null call is the placeholder detaching. The unmount cleanup below
      // owns removal, so placing the node here would re-attach it to the bar.
      if (!inline || !node || !focus) return;
      const target = host ?? inline;
      if (node.parentNode === target) return;
      target.appendChild(node);
      const last = focus.last;
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (last && lost && node.contains(last)) last.focus({ preventScroll: true });
    },
    [host, node, focus],
  );
  useLayoutEffect(() => () => node?.remove(), [node]);
  if (!node) return element;
  return (
    <>
      <div ref={placeholder} style={{ display: "contents" }} />
      {createPortal(element, node)}
    </>
  );
}

/**
 * The skeleton of a routed page: the regions a page stacks, top to bottom, at
 * the padding and the 24px rhythm no page restates. A header, then whatever
 * body the page's task calls for — a `ListCollection`, a set of `FormRows`, a
 * column of `Section` blocks.
 *
 * The rhythm sits here rather than in a per-layout wrapper because it is the
 * same rhythm whatever the body is. A layout ships a frame of its own only when
 * that frame differs from this one.
 */
export function Page({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page"
      className={cn("flex w-full min-w-0 flex-col gap-6 p-4 sm:p-6 lg:p-8", className)}
      {...props}
    />
  );
}

/**
 * The identity block at the top of a page: an optional `PageHeaderNav`, a
 * `PageHeading` carrying the title and description, and an optional
 * `PageActions`. The nav takes its own line, and the actions sit opposite the
 * heading on the line below it.
 *
 * `align` picks which edge the two sides meet on. A control is taller than the
 * title's line box — 36px against 24px — so it overhangs whichever end it is
 * not aligned to, and the page picks the end that reads as one row:
 *
 * - `end` when `PageActions` holds a single control that shares the title's
 *   row, so the control's bottom edge rests on the title's line box instead of
 *   hanging below it. A page-level view switch is the case this exists for.
 * - `start` when the actions may wrap or stack, which is every header carrying
 *   more than one control. Aligning those to the end would push the first row
 *   up off the title.
 */
export function PageHeader({
  align = "start",
  className,
  ...props
}: ComponentProps<"header"> & { align?: "start" | "end" }) {
  const hosts = useTopBarClaim();
  return (
    <HeaderTopBarContext.Provider value={hosts}>
      <header
        data-slot="page-header"
        data-align={align}
        className={cn(
          "flex flex-wrap justify-between gap-x-4 gap-y-2",
          align === "end" ? "items-end" : "items-start",
          className,
        )}
        {...props}
      />
    </HeaderTopBarContext.Provider>
  );
}

/**
 * Breadcrumb or back link above the title. Inside the shell, below `md` it
 * renders in the phone top bar instead, so hold it to one link that fits there.
 */
export function PageHeaderNav({ className, ...props }: ComponentProps<"div">) {
  const host = useContext(HeaderTopBarContext)?.nav ?? null;
  return useRelocated(
    <div data-slot="page-header-nav" className={cn(!host && "basis-full", className)} {...props} />,
    host,
  );
}

/** Groups the title with its description so the actions stay opposite both. */
export function PageHeading({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="page-heading"
      className={cn("flex min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

/**
 * The one `h1` a page carries. Inside the shell, the phone top bar repeats it
 * once the `h1` has scrolled up under the bar. The page keeps the large title at
 * rest, so the bar never shows the same words twice on one screen.
 */
export function PageTitle({ className, children, ref, ...props }: ComponentProps<"h1">) {
  const hosts = useContext(HeaderTopBarContext);
  const host = hosts?.title ?? null;
  const [heading, setHeading] = useState<HTMLHeadingElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLHeadingElement) => {
      setHeading(el);
      // Returning a cleanup tells React to call it instead of passing null,
      // so a caller's own cleanup runs exactly as it would on a plain `h1`.
      const cleanup = typeof ref === "function" ? ref(el) : undefined;
      if (ref && typeof ref === "object") ref.current = el;
      return () => {
        setHeading(null);
        if (typeof ref === "function") {
          if (typeof cleanup === "function") cleanup();
          else ref(null);
        } else if (ref) ref.current = null;
      };
    },
    [ref],
  );
  const under = useScrolledUnder(host ? heading : null, hosts?.edge ?? null);
  return (
    <>
      <h1
        ref={setRefs}
        data-slot="page-title"
        className={cn(
          "text-title text-foreground max-md:[--text-title:var(--rome-font-size-28)] max-md:[--text-title--line-height:var(--rome-line-height-129)] max-md:[--text-title--font-weight:700]",
          className,
        )}
        {...props}
      >
        {children}
      </h1>
      {host
        ? createPortal(
            // The `h1` stays the page's heading, so the bar's copy is hidden
            // from assistive technology.
            <span
              aria-hidden
              data-slot="page-top-bar-title"
              data-shown={under || undefined}
              className={cn(
                "block truncate transition-opacity duration-150 motion-reduce:transition-none",
                under ? "opacity-100" : "opacity-0",
              )}
            >
              {children}
            </span>,
            host,
          )
        : null}
    </>
  );
}

export function PageDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="page-description"
      className={cn("text-ui text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * Page-level controls, opposite the heading. Inside the shell, below `md` a lone
 * control renders in the phone top bar instead. Two or more stay in the page,
 * since the bar holds one.
 */
export function PageActions({ className, ...props }: ComponentProps<"div">) {
  const barHost = useContext(HeaderTopBarContext)?.action ?? null;
  const host = Children.toArray(props.children).length === 1 ? barHost : null;
  return useRelocated(
    <div
      data-slot="page-actions"
      className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
      {...props}
    />,
    host,
  );
}

export interface PageNavProps extends ComponentProps<"nav"> {
  /** Required: a page may carry more than one `nav`, and each needs its own name. */
  "aria-label": string;
}

/**
 * The strip of sibling views under the header, one entry per route. The view an
 * entry leads to replaces the page's body, so a page carrying this still has
 * one `h1` and one header.
 *
 * A `nav` of links, not a Radix `Tabs`. Each entry is a route change, and the
 * view it reveals renders as the body rather than inside a `TabsContent`, so
 * `role="tab"` would point `aria-controls` at tabpanel ids that do not exist.
 *
 * Renders its own `ul`, because a strip of links is a list and every entry is a
 * `PageNavLink`. The row scrolls sideways rather than wrapping: a second line of
 * entries reads as two strips, and the underline no longer marks one row.
 */
export function PageNav({ className, children, ...props }: PageNavProps) {
  return (
    <nav data-slot="page-nav" className={className} {...props}>
      <ul className="flex w-full justify-start gap-6 overflow-x-auto overflow-y-hidden border-b border-border">
        {children}
      </ul>
    </nav>
  );
}

export interface PageNavLinkProps extends ComponentProps<"a"> {
  /** Marks the entry the page is currently showing, as `aria-current="page"`. */
  active?: boolean;
  /** Renders the caller's element — a router `Link` — in place of the `a`. */
  asChild?: boolean;
}

/**
 * One entry in the strip. Renders its own `li`, so a caller cannot put the link
 * and the list item out of step.
 *
 * `active` both paints the underline and sets `aria-current="page"`, because a
 * strip that marks the current view only in ink names nothing for a reader who
 * is not looking at it.
 */
export function PageNavLink({
  active = false,
  asChild = false,
  className,
  ...props
}: PageNavLinkProps) {
  const Comp = asChild ? Slot : "a";
  return (
    <li data-slot="page-nav-item">
      <Comp
        data-slot="page-nav-link"
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative inline-flex items-center whitespace-nowrap px-2 py-1 text-ui transition-colors min-h-[var(--control-min-h)]",
          // A 2px border on a zero-content pseudo-element, not a sized box, so
          // it authors no off-scale edge length.
          "after:absolute after:inset-x-0 after:bottom-[-1px] after:border-b-2 after:border-foreground after:opacity-0 after:transition-opacity",
          active
            ? "text-foreground after:opacity-100"
            : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
          className,
        )}
        {...props}
      />
    </li>
  );
}

/** A titled block inside a page. Holds its own contents 12px apart. */
export function Section({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="section"
      className={cn("flex min-w-0 flex-col gap-3", className)}
      {...props}
    />
  );
}

/**
 * The heading block of a `Section`: a `SectionHeading` and an optional
 * `SectionActions` opposite it.
 */
export function SectionHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="section-header"
      className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-1", className)}
      {...props}
    />
  );
}

export function SectionHeading({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="section-heading"
      className={cn("flex min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

/** The `h2` a section carries. */
export function SectionTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      data-slot="section-title"
      className={cn("text-section text-foreground", className)}
      {...props}
    />
  );
}

export function SectionDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="section-description"
      className={cn("text-ui text-muted-foreground", className)}
      {...props}
    />
  );
}

export function SectionActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="section-actions"
      className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

/**
 * Caps its contents at the reading measure. Sits below the header, never
 * around it, so the header keeps the same position across routes.
 */
export function Measure({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="measure" className={cn("w-full max-w-2xl", className)} {...props} />;
}
