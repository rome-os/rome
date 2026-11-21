// The instance's own relay mailbox serves an app's webhooks, and also takes
// frames for connections that Rome Cloud deposits into it, such as Rome's
// Slack app. It is drained while an app takes its webhooks, as before, or while
// such a connection runs. With neither, nothing drains it and a webhook waits
// there until an app that takes it is installed.

import type { MailboxClaimed } from "./settings.js";

/** Counts the running connections that take frames from the mailbox, and
 *  calls `changed` when the first claim is made or the last one released. */
export class MailboxClaims implements MailboxClaimed {
  private held = 0;

  constructor(private readonly changed: () => void) {}

  get any(): boolean {
    return this.held > 0;
  }

  /** A claim, for as long as the connection runs. Releasing twice is safe. */
  claim(): () => void {
    let released = false;
    if (this.held++ === 0) this.changed();
    return () => {
      if (released) return;
      released = true;
      if (--this.held === 0) this.changed();
    };
  }
}
