import { useState } from "react";
import {
  DEFAULT_REPLAY_SETTINGS,
  normalizeReplaySettings,
  type ReplaySettings,
} from "../src/replay.js";

const STORAGE_KEY = "channel-test-ui:replay-settings";

/** The defaults, with the typewriter off for someone who asks for less motion. */
function defaults(): ReplaySettings {
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return { ...DEFAULT_REPLAY_SETTINGS, typewriter: !reduced };
}

function load(): ReplaySettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? normalizeReplaySettings(JSON.parse(stored), defaults()) : defaults();
  } catch {
    // Storage can be blocked, and a stored value can be corrupt.
    return defaults();
  }
}

function save(settings: ReplaySettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The settings still apply to this page.
  }
}

/** The replay settings, kept in this browser between visits. */
export function useReplaySettings() {
  const [settings, setSettings] = useState(load);
  const update = (next: ReplaySettings) => {
    const normalized = normalizeReplaySettings(next, defaults());
    setSettings(normalized);
    save(normalized);
  };
  return { settings, update, reset: () => update(defaults()) };
}
