import { createContext, type RefObject, useContext, useEffect, useRef } from "react";

/** The back step of the view drilled into in Settings, or null at a section's top. */
export const SettingsBackContext = createContext<RefObject<(() => void) | null> | null>(null);

/**
 * While the caller is mounted inside Settings, Escape calls `back` instead of
 * closing Settings, wherever focus is. Outside Settings it does nothing.
 */
export function useSettingsBack(back: () => void): void {
  const slot = useContext(SettingsBackContext);
  const latest = useRef(back);
  latest.current = back;
  useEffect(() => {
    if (!slot) return;
    const step = () => latest.current();
    slot.current = step;
    return () => {
      if (slot.current === step) slot.current = null;
    };
  }, [slot]);
}
