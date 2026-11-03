export interface SSEEvent {
  event: string;
  data: string;
}

export function parseSSEEvents(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  const parts = text.split("\n\n");
  for (const part of parts) {
    if (!part.trim()) continue;
    let event = "message";
    // Per the WHATWG EventSource spec, multiple `data:` lines in a single
    // event must be joined with `\n`. Earlier this method replaced instead
    // of appending, which silently truncated multi-line payloads.
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    const data = dataLines.join("\n");
    if (data) events.push({ event, data });
  }
  return events;
}

// The turn SSE server emits a keepalive every 15s (TURN_STREAM_KEEPALIVE_
// INTERVAL_MS in webchat.ts). If nothing arrives for this long the connection
// is dead — mobile background/lock, proxy idle timeout, network swap — and the
// reader would otherwise hang forever with no error, leaving the streaming UI
// (and the Stop button's turnId) stuck on a stale turn. Three missed
// keepalives + margin.
export const STREAM_STALL_TIMEOUT_MS = 50_000;

// A dropped turn stream is retried against the same turnId. Short and capped:
// the server answers definitively (replayed `done`, or 404 once the turn is
// gone), so a retry is cheap, and a resumed mobile tab catches up quickly.
export const TURN_RESUME_BASE_DELAY_MS = 1_000;
export const TURN_RESUME_MAX_DELAY_MS = 5_000;
