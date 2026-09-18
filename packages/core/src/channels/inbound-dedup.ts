/**
 * Idempotency guard for inbound channel events.
 *
 * The relay drainer delivers at-least-once (see `relay/drainer.ts`): the same
 * event is redelivered from the lowest un-acked `seq` on every reconnect, so a
 * single inbound can arrive twice when an ack is lost across a socket
 * drop/reconnect. For email that means the agent reprocesses — and may
 * re-reply to — the same message, a user-visible accident. Recording each
 * handled id and skipping repeats prevents that.
 *
 * This is intentionally a small interface so the storage can be swapped without
 * touching the call site. The in-memory implementation below covers the common
 * transient-reconnect case (network blip, relay restart, ping timeout — none of
 * which clears the process), but NOT a Rome restart landing in the
 * dispatch→ack window, since it lives only for the process lifetime. To close
 * that gap, drop in a persistent implementation (mirroring the connector's
 * `insertEventIfAbsent`) — the call site already awaits `checkAndRecord`.
 */
export interface InboundDedup {
  /**
   * Atomically record `key` and report whether it was already present.
   *
   * @returns `true` if `key` was seen before (caller should skip dispatch),
   *          `false` if it was newly recorded.
   */
  checkAndRecord(key: string): Promise<boolean>;
}

/**
 * Bounded, in-memory dedup. Once `maxEntries` is reached the oldest id is
 * evicted (a `Set` preserves insertion order) — old ids are not expected to be
 * redelivered after that many newer ones. State is lost on restart (see the
 * `InboundDedup` docs).
 */
export class InMemoryInboundDedup implements InboundDedup {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries = 1000) {}

  async checkAndRecord(key: string): Promise<boolean> {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }
}
