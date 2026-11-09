// Reading the generic part of an event a connection normalized: how it is
// addressed to the guardian, and its labels. Nothing here judges an event;
// whether it matters is triage's to say.

export type AddressedTo = "direct" | "copy" | "other";

const LABEL = /^[a-z0-9][a-z0-9:_-]{0,39}$/;
const MAX_LABELS = 20;

/** A connection's labels as a prompt can carry them: short lowercase words, each once. */
export function cleanLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels = value.filter(
    (label): label is string => typeof label === "string" && LABEL.test(label),
  );
  return [...new Set(labels)].slice(0, MAX_LABELS);
}

/** How an event is addressed to the guardian, read from what its connection said. */
export function addressedToOf(value: unknown): AddressedTo {
  return value === "direct" || value === "copy" ? value : "other";
}
