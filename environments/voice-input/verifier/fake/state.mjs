// The state the stand-in product and the fake voice-env share, kept in one JSON file so the
// fake voice-env can run as a separate command, as the real one does.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function emptyState(variant = "good") {
  return {
    variant,
    transcriber: { mode: "real", text: "", error: false },
    mic: null,
    nextId: 1,
    chats: {},
    capturing: false,
    captured: [],
    audioFiles: [],
    cloud: { signedIn: true, ownCredential: false, usage: [], gate: true, minted: 0 },
  };
}

export function readState(path) {
  if (!existsSync(path)) return emptyState();
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Applies `change` to the state on disk and returns the new state. */
export function updateState(path, change) {
  const state = readState(path);
  change(state);
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
  return state;
}
