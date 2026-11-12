import { createContext, type RefObject, useContext, useEffect, useRef } from "react";

/**
 * The back steps registered by the views drilled into in Settings, empty at a
 * section's top. Escape calls the last one.
 */
export const SettingsBackContext = createContext<RefObject<(() => void)[]> | null>(null);

/**
 * While the caller is mounted inside Settings, Escape calls `back` instead of
 * closing Settings, wherever focus is. Outside Settings it does nothing. When
 * several callers are mounted, the latest to register wins, and unmounting one
 * leaves the others registered.
 */
export function useSettingsBack(back: () => void): void {
  const steps = useContext(SettingsBackContext);
  const latest = useRef(back);
  latest.current = back;
  useEffect(() => {
    if (!steps) return;
    const step = () => latest.current();
    steps.current.push(step);
    return () => {
      steps.current = steps.current.filter((entry) => entry !== step);
    };
  }, [steps]);
}
