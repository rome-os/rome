// A Slack setup holds Slack frames in the instance's shared mailbox while it
// waits for the guardian's approval, and only for as long as it lives: an
// abandoned setup lets go, so the frames behind its hold flow again.

import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { makeSlackAppSetup } from "../connections/integrations/slack-app.js";
import { SLACK_DEPOSIT_HEADER, isSlackFrame } from "../connections/kinds/slack-app/deposit.js";
import { deliverSlackFrame, SlackSetupHolds } from "../connections/kinds/slack-app/drain.js";
import type { SlackAppCloud } from "../connections/kinds/slack-app/rome-cloud.js";
import { RelayDrainer } from "../relay/drainer.js";

/** A relay mailbox holding `events`, recording each ack. */
function fakeRelay(events: Array<{ seq: number; headers: Record<string, string> }>) {
  const acked: number[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws: ServerSocket) => {
    const pending = events.filter((e) => !acked.includes(e.seq));
    ws.send(JSON.stringify({ type: "ready", backlog: pending.length }));
    for (const e of pending) {
      ws.send(
        JSON.stringify({
          type: "event",
          seq: e.seq,
          receivedAt: 0,
          method: "POST",
          path: "/h/mailbox",
          headers: e.headers,
          body: Buffer.from("{}").toString("base64"),
        }),
      );
    }
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string; seq?: number };
      if (frame.type === "ack" && typeof frame.seq === "number") acked.push(frame.seq);
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    wss,
    acked,
    drain: {
      connectUrl: `ws://127.0.0.1:${port}/c/mailbox`,
      drainKey: "test-drain-key",
      targetAppId: "connector",
      targetPath: ["webhook"],
    },
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const neverApproved: SlackAppCloud = {
  connect: async () => ({ depositKey: "key-1", workspaces: [] }),
  disconnect: async () => {},
  workspaces: async () => [],
  installUrl: async () => "https://slack.com/oauth/v2/authorize?client_id=1",
};

const ctx = {
  step: <T>(_label: string, fn: (signal: AbortSignal) => Promise<T>) =>
    fn(new AbortController().signal),
  signal: new AbortController().signal,
};

const interact = {
  prompt: async () => ({}),
  show: () => {},
  redirect: async () => ({}),
};

describe("a Slack setup's hold on the shared mailbox", () => {
  let drainer: RelayDrainer | null = null;
  let relay: ReturnType<typeof fakeRelay> | null = null;

  afterEach(async () => {
    await drainer?.stop();
    relay?.wss.close();
    drainer = null;
    relay = null;
  });

  it("lets a webhook behind it flow once a setup the guardian never approves runs out of time", async () => {
    relay = fakeRelay([
      { seq: 1, headers: { [SLACK_DEPOSIT_HEADER]: "1" } },
      { seq: 2, headers: { "content-type": "application/json" } },
    ]);
    const holds = new SlackSetupHolds();
    const registry = { find: () => [], ingest: async () => null };
    const webhooks: number[] = [];
    drainer = new RelayDrainer(
      [relay.drain],
      async (_drain, event) => {
        if (isSlackFrame(event.headers)) {
          return deliverSlackFrame(registry, { headers: event.headers, body: event.body }, holds);
        }
        webhooks.push(event.seq);
        return { status: 200 };
      },
      { initialBackoffMs: 10, maxBackoffMs: 100, stableResetMs: 60_000 },
    );
    let setupEnded = false;
    const setup = makeSlackAppSetup({
      cloud: neverApproved,
      depositUrl: async () => "https://relay.example/h/a.b",
      approval: { pollMs: 5, limitMs: 300 },
      holdSlackFrames: () => holds.hold(),
    })(interact, ctx).catch(() => {
      setupEnded = true;
    });
    await waitFor(() => holds.any);
    drainer.start();

    // While the setup waits, the Slack frame is held, and the webhook behind it.
    await new Promise((r) => setTimeout(r, 150));
    expect(relay.acked).toEqual([]);
    expect(webhooks).toEqual([]);

    await setup;
    expect(setupEnded).toBe(true);
    expect(holds.any).toBe(false);
    // The Slack frame no connection will take is dropped, and the webhook flows.
    await waitFor(() => relay!.acked.includes(2), 10_000);
    expect(relay.acked).toEqual([1, 2]);
    expect(webhooks).toEqual([2]);
  }, 20_000);
});
