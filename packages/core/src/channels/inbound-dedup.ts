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
 * `insertEventIfAbsent`) — the call sites already await these operations.
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

export type DeferredInboundReservation =
  | { state: "complete" }
  | { state: "busy" }
  | { state: "saturated" }
  | {
      state: "acquired";
      commit(): Promise<void>;
      release(): Promise<void>;
    };

/**
 * Deferred commit variant for ingress that may ask the provider to retry.
 *
 * A future shared implementation must make `reserve` atomic across processes.
 * `busy` means another delivery has only reserved this key; `saturated` means
 * all bounded capacity is held by other live reservations. Both require a
 * provider retry; only `complete` is safe to acknowledge as a duplicate.
 */
export interface DeferredInboundDedup {
  reserve(key: string): Promise<DeferredInboundReservation>;
}

/**
 * Bounded, in-memory dedup. Once `maxEntries` is reached the oldest id is
 * evicted (a `Set` preserves insertion order) — old ids are not expected to be
 * redelivered after that many newer ones. State is lost on restart (see the
 * `InboundDedup` docs).
 */
export class InMemoryInboundDedup implements InboundDedup, DeferredInboundDedup {
  private readonly states = new Map<string, "pending" | "complete">();
  private completedCount = 0;

  constructor(private readonly maxEntries = 1000) {}

  async reserve(key: string): Promise<DeferredInboundReservation> {
    const existing = this.states.get(key);
    if (existing === "complete") return { state: "complete" };
    if (existing === "pending") return { state: "busy" };

    // Never let hung handlers grow the reservation map without bound. Returning
    // `busy` is deliberately retryable: unlike evicting a live reservation, it
    // cannot allow two handlers to process the same key concurrently.
    if (this.states.size >= this.maxEntries) {
      this.evictOneCompleted();
      if (this.states.size >= this.maxEntries) return { state: "saturated" };
    }
    this.states.set(key, "pending");
    let active = true;
    return {
      state: "acquired",
      commit: async () => {
        if (!active) return;
        active = false;
        if (this.states.get(key) !== "pending") return;
        this.states.delete(key);
        this.states.set(key, "complete");
        this.completedCount++;
        this.evictCompleted();
      },
      release: async () => {
        if (!active) return;
        active = false;
        if (this.states.get(key) === "pending") this.states.delete(key);
      },
    };
  }

  async checkAndRecord(key: string): Promise<boolean> {
    if (this.states.has(key)) return true;
    this.states.set(key, "complete");
    this.completedCount++;
    this.evictCompleted();
    return false;
  }

  private evictCompleted(): void {
    while (this.completedCount > this.maxEntries) {
      if (!this.evictOneCompleted()) return;
    }
  }

  private evictOneCompleted(): boolean {
    for (const [key, state] of this.states) {
      if (state !== "complete") continue;
      this.states.delete(key);
      this.completedCount--;
      return true;
    }
    return false;
  }
}
