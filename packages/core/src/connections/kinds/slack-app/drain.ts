// Frames the Slack gateway Worker deposits into the instance's own relay
// mailbox, picked out of that mailbox's drain. The mailbox also serves an app's
// webhooks and Rome's Discord bot, and it holds every later frame behind one it
// is asked to deliver again, for up to the drain's 2-minute budget per frame.
// So a Slack frame is delivered again only while its
// connection is starting and will take it, or while a Slack setup waits for the
// guardian to approve the app: with no Slack connection, or one that is
// broken, waiting for the guardian or locked, it is dropped and logged
// (docs/architecture/channels.md).

import { createLogger } from "../../../logger.js";
import { SLACK_APP_KIND } from "../../integrations/slack-app.js";
import type { ConnectionRegistry } from "../../registry.js";
import type { Connection } from "../../types.js";
import type { MailboxFrame } from "./slack-app.js";

const log = createLogger("slack-app");

/** The Slack setups waiting for approval. Slack's events for a workspace can
 *  arrive once the guardian approves, before the setup sees it and its grant
 *  makes the connection, so the mailbox holds them while a setup is open. */
export class SlackSetupHolds {
  private open = 0;

  get any(): boolean {
    return this.open > 0;
  }

  /** A hold for one setup, released once by the function it returns. */
  hold(): () => void {
    let done = false;
    this.open++;
    return () => {
      if (done) return;
      done = true;
      this.open--;
    };
  }
}

/** Whether `conn` has no ingress yet only because it is starting: its chat is
 *  unlocked and not waiting on the guardian, so it opens ingress on its own. */
function isStarting(conn: Pick<Connection, "status">): boolean {
  const chat = conn.status().chat;
  return chat.state === "unlocked" && !chat.degradation;
}

/**
 * Hands a Slack frame to Rome's Slack app connections, answering an HTTP status
 * the drain acts on. Each connection holds one workspace and answers 400 for a
 * frame of another, so the frame goes to the one that takes it. A frame none
 * takes is dropped, unless a connection that may take it is still starting or
 * a setup in `setups` may yet make one.
 */
export async function deliverSlackFrame(
  registry: Pick<ConnectionRegistry, "find" | "ingest">,
  frame: MailboxFrame,
  setups?: Pick<SlackSetupHolds, "any">,
): Promise<{ status: number }> {
  let starting = false;
  const notRunning: string[] = [];
  for (const conn of registry.find(SLACK_APP_KIND)) {
    let status: number;
    try {
      const result = (await registry.ingest(conn.id, frame)) as { status?: unknown } | null;
      status = typeof result?.status === "number" ? result.status : 200;
    } catch {
      // No ingress: the connection is starting, or it will not start alone.
      if (isStarting(conn)) starting = true;
      else notRunning.push(conn.id);
      continue;
    }
    if (status !== 400) return { status };
  }
  // The drain's retries reach the connection once it has started, or once the
  // setup has made it, within the drain's budget.
  if (starting || setups?.any) return { status: 503 };
  if (notRunning.length > 0) {
    log.warn("slack frame dropped: the connection is not running", {
      connectionIds: notRunning,
    });
  }
  return { status: 200 };
}
