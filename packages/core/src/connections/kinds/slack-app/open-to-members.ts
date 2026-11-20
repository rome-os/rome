// Which Slack app connections the guardian opened to their workspace's other
// members. The connection reads it for each message it hands over, so turning
// it off holds from the next message on. It is keyed by connection: a fix
// keeps the connection, so it keeps the setting, and any later connect of the
// workspace is a new connection, which starts closed whatever its disconnect
// managed to clean up.

import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../../../db/index.js";
import { slackAppOpenToMembers } from "../../../db/schema.js";

export interface SlackAppOpenToMembers {
  /** Whether connection `connectionId` is open to its workspace's other members. */
  isOpen(connectionId: string): boolean;
  /** Open connection `connectionId` to its workspace's other members, or close it. */
  set(connectionId: string, open: boolean): void;
}

export class SlackAppOpenToMembersRepository implements SlackAppOpenToMembers {
  constructor(private readonly db: DrizzleDb) {}

  isOpen(connectionId: string): boolean {
    return (
      this.db
        .select({ connectionId: slackAppOpenToMembers.connectionId })
        .from(slackAppOpenToMembers)
        .where(eq(slackAppOpenToMembers.connectionId, connectionId))
        .get() !== undefined
    );
  }

  set(connectionId: string, open: boolean): void {
    if (open) {
      this.db.insert(slackAppOpenToMembers).values({ connectionId }).onConflictDoNothing().run();
    } else {
      this.db
        .delete(slackAppOpenToMembers)
        .where(eq(slackAppOpenToMembers.connectionId, connectionId))
        .run();
    }
  }
}
