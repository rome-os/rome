import type { ChannelMessage } from "@rome-os/app-runtime";
import { describe, expect, it, rs } from "@rstest/core";
import {
  FORWARD_SIGNATURE_HEADER,
  FORWARD_TEAM_HEADER,
  FORWARD_TIMESTAMP_HEADER,
  forwardSignature,
} from "./forward.js";
import { type MailboxFrame, type OpenMailbox, SlackAppAdapter } from "./slack-app.js";
import { createSlackAppWebApi, type SlackAppWebApi } from "./web-api.js";
import { createTestDb } from "../../../test/db.js";
import { SlackMessageCopyRepository } from "./message-copy.js";

/** The connection's copy, in a database of its own. */
function testCopy(): SlackMessageCopyRepository {
  return new SlackMessageCopyRepository(createTestDb().db);
}

const TEAM = "T_A";
const BOT = "U_BOT";
const SECRET = "forward-secret-a";

function fakeApi(overrides: Partial<SlackAppWebApi> = {}): SlackAppWebApi {
  return {
    authTest: rs.fn(async () => ({ teamId: TEAM, botUserId: BOT, appId: "A_ROME" })),
    postMessage: rs.fn(async () => ({ ts: "2.0" })),
    openDirectMessage: rs.fn(async () => "D_NEW"),
    userName: rs.fn(async () => ({ displayName: "Ouou", username: "ouou" })),
    ...overrides,
  };
}

function dmEvent(i: number, overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: TEAM,
    api_app_id: "A_ROME",
    event_id: `Ev${i}`,
    event: {
      type: "message",
      channel_type: "im",
      channel: "D_GUARDIAN",
      user: "U_GUARDIAN",
      text: `message ${i}`,
      ts: `1700000000.${String(i).padStart(6, "0")}`,
    },
    ...overrides,
  };
}

/** A frame as Rome Cloud deposits it, signed with `secret` for `team`. */
function frame(payload: unknown, secret = SECRET, team = TEAM): MailboxFrame {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const timestamp = "1700000000";
  return {
    headers: {
      "content-type": "application/json",
      [FORWARD_TEAM_HEADER]: team,
      [FORWARD_TIMESTAMP_HEADER]: timestamp,
      [FORWARD_SIGNATURE_HEADER]: forwardSignature({
        forwardSecret: secret,
        timestamp,
        teamId: team,
        body,
      }),
    },
    body,
  };
}

/**
 * A relay mailbox: frames deposited while nothing drains it wait, and opening
 * a drain replays every frame not yet acknowledged, in order. A frame whose
 * delivery answered 2xx or a terminal 4xx is acknowledged.
 */
function fakeMailbox() {
  const queue: MailboxFrame[] = [];
  let onFrame: ((frame: MailboxFrame) => Promise<{ status: number }>) | null = null;
  const statuses: number[] = [];
  const pump = async () => {
    while (onFrame && queue.length > 0) {
      const { status } = await onFrame(queue[0]);
      statuses.push(status);
      if (status >= 500) return;
      queue.shift();
    }
  };
  const open: OpenMailbox = (_mailbox, handler) => {
    onFrame = handler;
    void pump();
    return {
      stop: () => {
        onFrame = null;
      },
    };
  };
  return {
    open,
    statuses,
    async deposit(...frames: MailboxFrame[]) {
      queue.push(...frames);
      await pump();
    },
    /** Deposit without draining: the instance is stopped. */
    hold(...frames: MailboxFrame[]) {
      queue.push(...frames);
    },
    async settle() {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function adapter(
  mailbox: ReturnType<typeof fakeMailbox>,
  api = fakeApi(),
  copy: SlackMessageCopyRepository = testCopy(),
  now?: () => Date,
) {
  const delivered: ChannelMessage[] = [];
  const faults: string[] = [];
  const a = new SlackAppAdapter({
    channel: "slack_app",
    botToken: "xoxb-a",
    teamId: TEAM,
    botUserId: BOT,
    forwardSecret: SECRET,
    mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: "k" },
    api,
    openMailbox: mailbox.open,
    onFault: ({ kind }) => faults.push(kind),
    copy,
    ...(now ? { now } : {}),
  });
  a.onInbound((message) => delivered.push(message));
  return { adapter: a, delivered, faults, api, copy };
}

describe("Slack app direct messages (R4)", () => {
  it("delivers 20 of 20 direct messages once each, in the direct message they came from", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    for (let i = 0; i < 20; i++) await mailbox.deposit(frame(dmEvent(i)));
    // Slack retries and the relay redelivers: every event arrives again.
    for (let i = 0; i < 20; i++) await mailbox.deposit(frame(dmEvent(i)));

    expect(delivered).toHaveLength(20);
    expect(new Set(delivered.map((m) => m.messageId)).size).toBe(20);
    for (const message of delivered) {
      expect(message).toMatchObject({
        channel: "slack_app",
        chatId: "D_GUARDIAN",
        senderId: "T_A/U_GUARDIAN",
        senderDisplayName: "Ouou",
        thread: { kind: "dm" },
        addressing: "direct",
      });
    }
  });

  it("replies in the same direct message through Slack's Web API", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, api } = adapter(mailbox);
    await a.start();
    const receipt = await a.send("D_GUARDIAN" as never, { text: "hello" } as never);
    expect(api.postMessage).toHaveBeenCalledWith(
      "xoxb-a",
      { channel: "D_GUARDIAN", markdown: "hello", threadTs: undefined },
      expect.anything(),
    );
    expect(receipt).toMatchObject({ chatId: "D_GUARDIAN", messageId: "2.0" });
  });

  it("hears nothing but direct messages from people in the workspace", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    const base = dmEvent(1);
    await mailbox.deposit(
      frame({ ...base, event_id: "E1", event: { ...base.event, user: BOT } }),
      frame({ ...base, event_id: "E2", event: { ...base.event, bot_id: "B1" } }),
      frame({ ...base, event_id: "E3", event: { ...base.event, subtype: "message_changed" } }),
      frame({ ...base, event_id: "E4", event: { ...base.event, user_team: "T_OTHER" } }),
      frame({ ...base, event_id: "E5", event: { ...base.event, type: "app_mention" } }),
    );
    expect(delivered).toHaveLength(0);
  });

  it("refuses to start on a token that answers as another bot", async () => {
    const mailbox = fakeMailbox();
    const api = fakeApi({ authTest: rs.fn(async () => ({ teamId: "T_B", botUserId: BOT })) });
    await expect(adapter(mailbox, api).adapter.start()).rejects.toThrow(/another Slack bot/);
  });

  it("reports a removed app as a refused credential", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, faults } = adapter(mailbox);
    await a.start();
    await mailbox.deposit(frame({ ...dmEvent(1), event: { type: "app_uninstalled" } }));
    expect(faults).toEqual(["credential"]);
  });
});

describe("Slack app while the instance is stopped (R6)", () => {
  it("answers each of 20 messages sent during a stop once, after restart", async () => {
    const mailbox = fakeMailbox();
    const first = adapter(mailbox);
    await first.adapter.start();
    await first.adapter.stop();

    for (let i = 0; i < 20; i++) mailbox.hold(frame(dmEvent(i)));
    // A Slack retry of the same events lands in the mailbox too.
    for (let i = 0; i < 5; i++) mailbox.hold(frame(dmEvent(i)));

    const restarted = adapter(mailbox);
    await restarted.adapter.start();
    await mailbox.settle();
    expect(restarted.delivered.map((m) => m.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `message ${i}`),
    );
  });
});

describe("Slack app's own copy of its direct messages", () => {
  const at = (minute: number) => () => new Date(Date.UTC(2026, 10, 19, 12, minute));

  it("tells the mailbox a message arrived only once its copy holds it", async () => {
    const mailbox = fakeMailbox();
    const copy = testCopy();
    const keep = copy.keep.bind(copy);
    let failing = true;
    copy.keep = (kept, when) => {
      if (failing) throw new Error("disk full");
      return keep(kept, when);
    };
    const { adapter: a, delivered, faults } = adapter(mailbox, fakeApi(), copy);
    await a.start();

    await mailbox.deposit(frame(dmEvent(1)));
    expect(mailbox.statuses).toEqual([500]);
    expect(delivered).toHaveLength(0);
    // The drain stops retrying a frame after a few tries, so the connection is
    // reported down and starts again with a fresh drain.
    expect(faults).toEqual(["transport"]);

    // The mailbox kept the frame and delivers it again.
    failing = false;
    await mailbox.deposit();
    expect(mailbox.statuses).toEqual([500, 200]);
    expect(delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("hands Rome on start what it kept but never handed over", async () => {
    const { db } = createTestDb();
    // Kept, then stopped before noting it was handed over.
    const interrupted = new SlackMessageCopyRepository(db);
    interrupted.handedOver = () => {};
    const first = adapter(fakeMailbox(), fakeApi(), interrupted, at(0));
    await first.adapter.start();
    await first.adapter.handleFrame(frame(dmEvent(1)));
    await first.adapter.stop();

    const copy = new SlackMessageCopyRepository(db);
    const restarted = adapter(fakeMailbox(), fakeApi(), copy, at(30));
    await restarted.adapter.start();
    expect(restarted.delivered.map((m) => m.text)).toEqual(["message 1"]);
    expect(restarted.delivered[0]?.timestamp).toEqual(first.delivered[0]?.timestamp);

    // Each start offers the last hand-offs again; Rome ignores what it holds.
    const again = adapter(fakeMailbox(), fakeApi(), copy, at(50));
    await again.adapter.start();
    expect(again.delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("hands Rome again on start what it handed over just before a stop, however long the stop", async () => {
    const { db } = createTestDb();
    const copy = new SlackMessageCopyRepository(db);
    const first = adapter(fakeMailbox(), fakeApi(), copy, at(0));
    await first.adapter.start();
    await first.adapter.handleFrame(frame(dmEvent(1)));
    await first.adapter.stop();

    // A reload a minute later: Rome may not have recorded it yet.
    const reloaded = adapter(fakeMailbox(), fakeApi(), copy, at(1));
    await reloaded.adapter.start();
    expect(reloaded.delivered.map((m) => m.text)).toEqual(["message 1"]);

    // A restart hours later still hands over what came just before the stop.
    const late = adapter(
      fakeMailbox(),
      fakeApi(),
      copy,
      () => new Date(Date.UTC(2026, 10, 19, 15)),
    );
    await late.adapter.start();
    expect(late.delivered.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("hands Rome again only what came just before the last hand-off", async () => {
    const { db } = createTestDb();
    const copy = new SlackMessageCopyRepository(db);
    const first = adapter(fakeMailbox(), fakeApi(), copy, at(0));
    await first.adapter.start();
    await first.adapter.handleFrame(frame(dmEvent(1)));
    await first.adapter.stop();
    const second = adapter(fakeMailbox(), fakeApi(), copy, at(40));
    await second.adapter.start();
    await second.adapter.handleFrame(frame(dmEvent(2)));
    await second.adapter.stop();

    // Message 1 was handed over 40 minutes before the last hand-off.
    const restarted = adapter(fakeMailbox(), fakeApi(), copy, at(50));
    await restarted.adapter.start();
    expect(restarted.delivered.map((m) => m.text)).toEqual(["message 2"]);
  });

  it("hands over a message Slack delivers again after a restart only once", async () => {
    const mailbox = fakeMailbox();
    const copy = testCopy();
    const first = adapter(mailbox, fakeApi(), copy, at(0));
    await first.adapter.start();
    await mailbox.deposit(frame(dmEvent(1)));
    await first.adapter.stop();

    const restarted = adapter(mailbox, fakeApi(), copy, at(30));
    await restarted.adapter.start();
    // Start offers it again, since a stop may have cut it off before Rome
    // recorded it; Slack's own redelivery adds nothing on top.
    expect(restarted.delivered.map((m) => m.text)).toEqual(["message 1"]);
    await mailbox.deposit(frame(dmEvent(1)));
    expect(first.delivered).toHaveLength(1);
    expect(restarted.delivered).toHaveLength(1);
  });
});

describe("Slack app frames that did not come from Rome Cloud (R7)", () => {
  it("drops 10 of 10 frames with a bad forward signature", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    for (let i = 0; i < 10; i++) await mailbox.deposit(frame(dmEvent(i), `wrong-${i}`));
    expect(delivered).toHaveLength(0);
    expect(mailbox.statuses).toEqual(Array(10).fill(401));
  });

  it("drops 20 of 20 frames forwarded for another workspace", async () => {
    const mailbox = fakeMailbox();
    const { adapter: a, delivered } = adapter(mailbox);
    await a.start();
    for (let i = 0; i < 10; i++) {
      // Signed for B with B's secret: the header names another workspace.
      await mailbox.deposit(frame({ ...dmEvent(i), team_id: "T_B" }, "secret-b", "T_B"));
      // Signed for A, with a body from B.
      await mailbox.deposit(frame({ ...dmEvent(100 + i), team_id: "T_B" }));
    }
    expect(delivered).toHaveLength(0);
  });
});

describe("Slack app Web API", () => {
  it("calls the configured Slack origin for every method", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({
        ok: true,
        team_id: TEAM,
        user_id: BOT,
        ts: "1.0",
        channel: { id: "D1" },
        user: { name: "n" },
      });
    }) as typeof fetch;
    const api = createSlackAppWebApi("http://fake-slack.test:8080/ignored", fetchImpl);
    await api.authTest("t");
    await api.postMessage("t", { channel: "D1", markdown: "hi" });
    await api.openDirectMessage("t", "U1");
    await api.userName("t", "U1");
    expect(urls.map((url) => new URL(url).origin)).toEqual(
      Array(4).fill("http://fake-slack.test:8080"),
    );
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      "/api/auth.test",
      "/api/chat.postMessage",
      "/api/conversations.open",
      "/api/users.info",
    ]);
  });
});

describe("Slack app mailbox key", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 10, 19);
  const keyExpiringAt = (ms: number, tag = "sig") => `${Math.floor(ms / 1000)}.${tag}`;

  function renewing(
    stored: string,
    refresh: () => Promise<{ connectUrl: string; drainKey: string }>,
  ) {
    const opened: string[] = [];
    const stopped: string[] = [];
    const faults: string[] = [];
    const refreshed: string[] = [];
    const open: OpenMailbox = (mailbox) => {
      opened.push(mailbox.drainKey);
      return { stop: () => void stopped.push(mailbox.drainKey) };
    };
    const a = new SlackAppAdapter({
      channel: "slack_app",
      botToken: "xoxb-a",
      teamId: TEAM,
      botUserId: BOT,
      forwardSecret: SECRET,
      mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: stored },
      api: fakeApi(),
      openMailbox: open,
      refreshMailbox: rs.fn(refresh),
      onMailboxRefreshed: (mailbox) => refreshed.push(mailbox.drainKey),
      onFault: ({ kind }) => faults.push(kind),
      copy: testCopy(),
    });
    return { adapter: a, opened, stopped, faults, refreshed };
  }

  async function withClock(run: () => Promise<void>) {
    rs.useFakeTimers();
    rs.setSystemTime(NOW);
    try {
      await run();
    } finally {
      rs.useRealTimers();
    }
  }

  it("refuses to drain with an expired key it could not renew, and drains once Rome Cloud recovers", () =>
    withClock(async () => {
      const expired = keyExpiringAt(NOW - DAY);
      const fresh = keyExpiringAt(NOW + 90 * DAY, "fresh");
      let cloudUp = false;
      const t = renewing(expired, async () => {
        if (!cloudUp) throw new Error("Rome Cloud unreachable");
        return { connectUrl: "wss://relay.test/c/mbx", drainKey: fresh };
      });
      await expect(t.adapter.start()).rejects.toThrow("expired");
      expect(t.opened).toEqual([]);
      // The runtime restarts the connection after a Disconnected fault.
      cloudUp = true;
      await t.adapter.start();
      expect(t.opened).toEqual([fresh]);
      expect(t.refreshed).toEqual([fresh]);
      await t.adapter.stop();
    }));

  it("renews the key a week before it expires and reopens the drain with it", () =>
    withClock(async () => {
      const first = keyExpiringAt(NOW + 30 * DAY, "first");
      const second = keyExpiringAt(NOW + 120 * DAY, "second");
      let answer = first;
      const t = renewing(first, async () => ({
        connectUrl: "wss://relay.test/c/mbx",
        drainKey: answer,
      }));
      await t.adapter.start();
      expect(t.opened).toEqual([first]);
      answer = second;
      await rs.advanceTimersByTimeAsync(22 * DAY);
      expect(t.opened).toEqual([first]);
      await rs.advanceTimersByTimeAsync(1 * DAY + 1000);
      expect(t.opened).toEqual([first, second]);
      expect(t.stopped).toEqual([first]);
      expect(t.refreshed).toEqual([second]);
      expect(t.faults).toEqual([]);
      await t.adapter.stop();
    }));

  it("lets the old drain finish its message before the renewed drain opens", () =>
    withClock(async () => {
      const first = keyExpiringAt(NOW + 8 * DAY, "first");
      const second = keyExpiringAt(NOW + 98 * DAY, "second");
      let releaseName!: () => void;
      const nameHeld = new Promise<void>((resolve) => {
        releaseName = resolve;
      });
      const order: string[] = [];
      let inFlight: Promise<unknown> = Promise.resolve();
      // Like the relay drainer, stopping waits for the delivery in flight.
      const open: OpenMailbox = (mailbox, onFrame) => {
        order.push(`open ${mailbox.drainKey.split(".")[1]}`);
        if (mailbox.drainKey === first) inFlight = onFrame(frame(dmEvent(1)));
        return {
          stop: async () => {
            await inFlight;
            order.push(`stopped ${mailbox.drainKey.split(".")[1]}`);
          },
        };
      };
      let answer = first;
      const a = new SlackAppAdapter({
        channel: "slack_app",
        botToken: "xoxb-a",
        teamId: TEAM,
        botUserId: BOT,
        forwardSecret: SECRET,
        mailbox: { connectUrl: "wss://relay.test/c/mbx", drainKey: first },
        api: fakeApi({
          userName: rs.fn(async () => {
            await nameHeld;
            return { displayName: "Ouou" };
          }),
        }),
        openMailbox: open,
        refreshMailbox: async () => ({ connectUrl: "wss://relay.test/c/mbx", drainKey: answer }),
        copy: testCopy(),
      });
      a.onInbound((message) => order.push(`delivered ${message.text}`));
      await a.start();
      answer = second;
      await rs.advanceTimersByTimeAsync(DAY + 1000);
      expect(order).toEqual(["open first"]);
      releaseName();
      await rs.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["open first", "delivered message 1", "stopped first", "open second"]);
      await a.stop();
    }));

  it("drops a refresh that answers after the adapter stopped, without persisting it", async () => {
    const stored = "k-stored";
    let answer!: (mailbox: { connectUrl: string; drainKey: string }) => void;
    const t = renewing(
      stored,
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const started = t.adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A regrant replaces this adapter while Rome Cloud is still answering.
    await t.adapter.stop();
    answer({ connectUrl: "wss://relay.test/c/mbx", drainKey: "k-late" });
    await started;
    expect(t.refreshed).toEqual([]);
    expect(t.opened).toEqual([]);
  });

  it("retries a failed renewal hourly, and reports the connection down once the key expires", () =>
    withClock(async () => {
      const key = keyExpiringAt(NOW + 7 * DAY + 2 * 60 * 60 * 1000);
      let calls = 0;
      const t = renewing(key, async () => {
        calls++;
        if (calls === 1) return { connectUrl: "wss://relay.test/c/mbx", drainKey: key };
        throw new Error("Rome Cloud unreachable");
      });
      await t.adapter.start();
      await rs.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1000);
      expect(calls).toBe(2);
      await rs.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      expect(calls).toBe(5);
      expect(t.faults).toEqual([]);
      await rs.advanceTimersByTimeAsync(7 * DAY);
      expect(t.faults).toEqual(["transport"]);
      await t.adapter.stop();
    }));
});
