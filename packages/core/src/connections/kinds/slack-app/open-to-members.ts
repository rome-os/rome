// Which Slack app accounts the guardian opened to their workspace's other
// members. The connection reads it for each message it hands over, so turning
// it off holds from the next message on. Repair keeps the account, so it keeps
// the setting; disconnect forgets it.

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../../db/index.js";
import { slackAppOpenToMembers } from "../../../db/schema.js";

export interface SlackAppOpenToMembers {
  /** Whether account `accountId` is open to its workspace's other members. */
  isOpen(accountId: string): boolean;
  /** Open account `accountId` to its workspace's other members, or close it. */
  set(accountId: string, open: boolean): void;
}

export class SlackAppOpenToMembersRepository implements SlackAppOpenToMembers {
  constructor(private readonly db: DrizzleDb) {}

  isOpen(accountId: string): boolean {
    return (
      this.db
        .select({ accountId: slackAppOpenToMembers.accountId })
        .from(slackAppOpenToMembers)
        .where(eq(slackAppOpenToMembers.accountId, accountId))
        .get() !== undefined
    );
  }

  set(accountId: string, open: boolean): void {
    if (open) {
      this.db.insert(slackAppOpenToMembers).values({ accountId }).onConflictDoNothing().run();
    } else {
      this.db
        .delete(slackAppOpenToMembers)
        .where(eq(slackAppOpenToMembers.accountId, accountId))
        .run();
    }
  }
}
