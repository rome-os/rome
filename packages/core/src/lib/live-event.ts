/**
 * Pushes one event to a live subscriber, over whichever transport carries it.
 * `data` is the JSON payload the SSE route writes. Must not block: the sources
 * call it inline from their own fan-out.
 */
export type LiveEventEmit = (event: string, data: unknown) => void;
