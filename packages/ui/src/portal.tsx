import { useCallback, useState, type ComponentType, type ReactNode } from "react";
import { UiScaleScope, useOptionalUiScale } from "./ui-scale.js";
import { resolvePortalContainer } from "./portal-container.js";

// Internal to the kit, like `portal-container.ts` — deliberately absent from
// `src/index.ts` and the package `exports` map.

/**
 * The shape every Radix portal primitive shares: `Dialog.Portal`,
 * `Popover.Portal`, `Select.Portal`, … all take an optional container and fall
 * back to `document.body` when it is undefined.
 */
type PortalPrimitive = ComponentType<{ container?: HTMLElement; children?: ReactNode }>;

/**
 * Radix's portal with the container resolved from where the component sits in
 * the tree: the app's shadow root when there is one, Radix's `document.body`
 * default otherwise. Every floating component in the kit wraps its content in
 * this instead of the bare primitive, which is what makes them correct in both
 * hosts by construction.
 *
 * `resolvePortalContainer` needs a live DOM node to resolve from, and a portal
 * has none of its own — its content is elsewhere by definition. Hence the
 * hidden marker: it renders at the component's own position in the light DOM,
 * so its root node is the app's shadow root exactly when the floating layer
 * belongs there.
 *
 * A resolver that finds no shadow root leaves the state untouched, so in a
 * plain document (the dashboard) this renders exactly what the bare primitive
 * would, in the same single pass — no extra commit to shift the timing Radix's
 * open/close/focus-restore sequence runs on.
 *
 * Inside a shadow root the container arrives one commit later, and changing a
 * `createPortal` target re-creates the portaled subtree. That is deliberate:
 * the swap happens at *this* component's mount, when a closed layer has no
 * portaled children at all (Radix gates them behind `Presence`), so the remount
 * is of an empty portal. A layer already open at mount does take a real
 * remount — `dialog.test.tsx` pins that it keeps focus — and paying it there
 * buys the dashboard's 68 call sites an unchanged render path.
 */
export function AutoPortal({
  portal: Portal,
  children,
}: {
  portal: PortalPrimitive;
  children: ReactNode;
}) {
  const scale = useOptionalUiScale();
  // Stays undefined outside a shadow root — the value Radix reads as "use
  // document.body", and no state update means no re-render there.
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined);
  const resolveFromMarker = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    const resolved = resolvePortalContainer(node);
    if (resolved) setContainer(resolved);
  }, []);

  return (
    <>
      <span hidden ref={resolveFromMarker} />
      <Portal container={container}>
        {scale ? <UiScaleScope scale={scale}>{children}</UiScaleScope> : children}
      </Portal>
    </>
  );
}
