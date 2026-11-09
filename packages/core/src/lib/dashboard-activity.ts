/**
 * Whether the guardian is at one of their web dashboards now. A guardian
 * dashboard socket counts as active for {@link DASHBOARD_ACTIVE_MS} after its
 * last `active` signal, and stops counting at once when it says `away` or
 * closes. While any one counts, the Concierge pushes nothing to the guardian's
 * phone: docs/architecture/notification-delivery.md.
 */
export const DASHBOARD_ACTIVE_MS = 60_000;

/** One dashboard socket's signals. Every call after `close()` does nothing. */
export interface DashboardSocketActivity {
  active(): void;
  away(): void;
  close(): void;
}

export class DashboardActivity {
  /** The time of each socket's last `active` signal, while it may still count. */
  private readonly lastActive = new Map<object, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts tracking one socket, as not active until its first `active()`. */
  open(): DashboardSocketActivity {
    const socket = {};
    let closed = false;
    return {
      active: () => {
        if (!closed) this.lastActive.set(socket, this.now());
      },
      away: () => {
        this.lastActive.delete(socket);
      },
      close: () => {
        closed = true;
        this.lastActive.delete(socket);
      },
    };
  }

  isActive(): boolean {
    const now = this.now();
    for (const [socket, at] of this.lastActive) {
      if (now - at < DASHBOARD_ACTIVE_MS) return true;
      this.lastActive.delete(socket);
    }
    return false;
  }
}
