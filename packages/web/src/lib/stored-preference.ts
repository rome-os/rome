// A preference this browser keeps in localStorage. Storage can be missing
// (server render), blocked (private mode, site settings) or full, and a
// preference is a convenience, so every failure reads as "nothing stored" and
// a failed write is dropped.

/** The stored string, or null when nothing is stored or storage is unavailable. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value`, or removes the key when it is null. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // The preference holds for this page only.
  }
}

/**
 * The stored JSON value, or undefined when nothing is stored, storage is
 * unavailable, or the text is not JSON. The caller checks its shape.
 */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writeStoredJson(key: string, value: unknown): void {
  writeStored(key, JSON.stringify(value));
}
