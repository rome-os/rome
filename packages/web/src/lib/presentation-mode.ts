import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "@/lib/stored-preference";

// Presentation mode is a global, purely cosmetic rendering preference: while it
// is on, chat surfaces render every session with the main assistant's identity
// (no pinned-agent avatar, label, or composer chip), so a screen recording of
// an agent-driven session — e.g. a Replay playback — is indistinguishable from
// a normal chat. It masks rendering only; session data, routing, and the agent
// actually bound to a session are untouched.
//
// Stored per-browser (localStorage, matching the theme preference) rather than
// in guardian settings: a recording setup is a property of the machine doing
// the recording, and keeping it client-side means no API surface.
export const PRESENTATION_MODE_STORAGE_KEY = "rome-presentation-mode";

// Same-tab writes don't fire the `storage` event, so setPresentationMode
// dispatches this for subscribers in the writing tab; `storage` covers other tabs.
const PRESENTATION_MODE_EVENT = "rome:presentation-mode-changed";

export function isPresentationMode(): boolean {
  return readStored(PRESENTATION_MODE_STORAGE_KEY) === "1";
}

export function setPresentationMode(on: boolean): void {
  // Unpersistable storage still notifies, so the current tab reflects the choice.
  writeStored(PRESENTATION_MODE_STORAGE_KEY, on ? "1" : null);
  window.dispatchEvent(new Event(PRESENTATION_MODE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(PRESENTATION_MODE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PRESENTATION_MODE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Reactive read of the presentation-mode flag: re-renders the subscriber when
 * the mode is toggled anywhere, including an already-open chat. */
export function usePresentationMode(): boolean {
  return useSyncExternalStore(subscribe, isPresentationMode);
}
