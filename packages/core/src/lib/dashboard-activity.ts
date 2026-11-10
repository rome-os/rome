/**
 * Whether each person is at one of their web dashboards now, the guardian or
 * a visitor. A dashboard socket counts as active for {@link DASHBOARD_ACTIVE_MS}
 * after its last `active` signal, for the person signed in on it, and stops
 * counting at once when it says `away` or closes. While any of a person's
 * dashboards counts, the Concierge pushes nothing to that person's phone:
 * docs/architecture/notification-delivery.md.
 */
export const DASHBOARD_ACTIVE_MS = 60_000;

/** One dashboard socket's signals. Every call after `close()` does nothing. */
export interface DashboardSocketActivity {
  active(): void;
  away(): void;
  close(): void;
}

export class DashboardActivity {
  /** Each socket's owner and the time of its last `active` signal, while it may still count. */
  private readonly lastActive = new Map<object, { owner: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts tracking one of `owner`'s sockets, as not active until its first `active()`. */
  open(owner: string): DashboardSocketActivity {
    const socket = {};
    let closed = false;
    return {
      active: () => {
        if (!closed) this.lastActive.set(socket, { owner, at: this.now() });
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

  isActive(owner: string): boolean {
    const now = this.now();
    let active = false;
    for (const [socket, last] of this.lastActive) {
      if (now - last.at >= DASHBOARD_ACTIVE_MS) this.lastActive.delete(socket);
      else if (last.owner === owner) active = true;
    }
    return active;
  }
}
