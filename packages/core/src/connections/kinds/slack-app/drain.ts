// Frames the Slack gateway Worker deposits into the instance's own relay
// mailbox, picked out of that mailbox's drain. The mailbox otherwise serves an
// app's webhooks, so a Slack frame never fails in a way that holds those up for
// good: with no Slack connection it is dropped, and one its connection could
// not take yet is delivered again.

import { SLACK_APP_KIND } from "../../integrations/slack-app.js";
import type { ConnectionRegistry } from "../../registry.js";
import type { MailboxFrame } from "./slack-app.js";

/**
 * Hands a Slack frame to Rome's Slack app connections, answering an HTTP status
 * the drain acts on. Each connection holds one workspace and answers 400 for a
 * frame of another, so the frame goes to the one that takes it; a frame none
 * takes is dropped.
 */
export async function deliverSlackFrame(
  registry: Pick<ConnectionRegistry, "find" | "ingest">,
  frame: MailboxFrame,
): Promise<{ status: number }> {
  for (const conn of registry.find(SLACK_APP_KIND)) {
    let status: number;
    try {
      const result = (await registry.ingest(conn.id, frame)) as { status?: unknown } | null;
      status = typeof result?.status === "number" ? result.status : 200;
    } catch {
      // Ingress opens when the connection starts; until then the frame waits.
      return { status: 503 };
    }
    if (status !== 400) return { status };
  }
  return { status: 200 };
}
