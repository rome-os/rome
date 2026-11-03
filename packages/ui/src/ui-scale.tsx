import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

export type UiScale = "medium" | "large";
export type UiScalePreference = UiScale | "auto";

const UiScaleContext = createContext<UiScale | undefined>(undefined);
const POINTER_QUERY = "(pointer: coarse)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(POINTER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function prefersLarge(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(POINTER_QUERY).matches;
}

const serverSnapshot = () => false;
const noSubscription = () => () => {};

export interface UiScaleProviderProps {
  children: ReactNode;
  scale?: UiScalePreference;
}

/** Selects control density independently of the page's layout breakpoints. */
export function UiScaleProvider({ children, scale = "auto" }: UiScaleProviderProps) {
  const coarse = useSyncExternalStore(
    scale === "auto" && typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? subscribe
      : noSubscription,
    prefersLarge,
    serverSnapshot,
  );
  const resolved = scale === "auto" ? (coarse ? "large" : "medium") : scale;
  return (
    <UiScaleContext.Provider value={resolved}>
      <UiScaleScope scale={resolved}>{children}</UiScaleScope>
    </UiScaleContext.Provider>
  );
}

export function useUiScale(): UiScale {
  return useContext(UiScaleContext) ?? "medium";
}

export function useOptionalUiScale(): UiScale | undefined {
  return useContext(UiScaleContext);
}

/** Carries the selected variables into a portal without adding a layout box. */
export function UiScaleScope({ children, scale }: { children: ReactNode; scale: UiScale }) {
  return (
    <div
      data-ui-scale={scale}
      style={{
        display: "contents",
        fontSize: "var(--text-ui)",
        lineHeight: "var(--text-ui--line-height)",
      }}
    >
      {children}
    </div>
  );
}
