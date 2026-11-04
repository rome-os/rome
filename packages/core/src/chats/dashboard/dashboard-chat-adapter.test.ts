// PROTOTYPE (investigation branch): the dashboard adapter through the chat
// adapter conformance suite, as every platform runs it, plus what the
// browser needs beyond it.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { ChannelMessage, ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";
import { SendRefused } from "@rome-os/app-runtime";
import { v4 as uuid } from "uuid";
import { chatsWiring } from "../../chats-wiring.js";
import { ChatEvents, type MessageSaid } from "../storage/events.js";
import { inboundRecording } from "../../connections/inbound-recording.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { channelOver, describeAdapterConformance } from "../../test/kit/im/adapter-conformance.js";
import type { VisibleMessage } from "../../test/kit/im/peer.js";
import type { DashboardChatAdapter } from "./dashboard-chat-adapter.js";

const MAIN = { platform: "webchat", id: "agent:main" };
const GUARDIAN = "guardian";

/** The browser and the dashboard's channel for one agent's account. The
 *  browser shows what Rome sends as Rome's server pushes it. */
function dashboardPeer() {
  const shown: VisibleMessage[] = [];
  let handler: ((message: ChannelMessage) => Promise<void>) | null = null;
  let refuse = false;
  const adapter = {
    async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
      if (refuse) {
        refuse = false;
        throw new SendRefused("empty", "A dashboard message needs text, parts or an attachment");
      }
      const messageId = uuid();
      shown.push({
        id: messageId,
        conversation: chatId,
        from: "rome",
        text: message.text ?? "",
        ...(message.replyToMessageId ? { replyTo: message.replyToMessageId } : {}),
        edits: 0,
      });
      return { chatId, messageId };
    },
    onInbound(on: (message: ChannelMessage) => Promise<void>) {
      handler = on;
    },
  };
  const channel = channelOver("webchat", "", adapter);
  /** The guardian types `text` in chat `session`; the browser's id for it. */
  const browserSends = (session: string, text: string, key: string = uuid()): string => {
    shown.push({ id: key, conversation: session, from: "user", text, edits: 0 });
    void handler?.({
      channel: "webchat",
      direction: "inbound",
      messageId: key,
      chatId: session as ChatId,
      senderId: GUARDIAN,
      text,
      attachments: [],
      timestamp: new Date(),
      thread: { kind: "dm" },
    } as ChannelMessage);
    return key;
  };
  return {
    channel,
    browserSends,
    visible: (at: string) => shown.filter((message) => message.conversation === at),
    refuseNextSend: () => {
      refuse = true;
    },
  };
}

describeAdapterConformance(
  "Dashboard",
  async () => {
    const peer = dashboardPeer();
    const session = uuid();
    return {
      account: MAIN,
      channel: peer.channel,
      // A dashboard chat is reached by the session that stands in it: the
      // guardian holds one per chat they start with the agent.
      direct: {
        person: session,
        at: session,
        personWrites: (text) => peer.browserSends(session, text),
      },
      visible: peer.visible,
      refuseNextSend: peer.refuseNextSend,
      stop: async () => {},
    };
  },
  // Forks could become threads later. Today a dashboard chat has none.
  { directMessages: true, romeWritesFirst: true, groups: false, twoAccounts: false, threads: false },
);

describe("dashboard adapter: what the browser needs beyond the contract", () => {
  let testDb: TestDb;
  let said: MessageSaid[];
  let adapter: DashboardChatAdapter;
  let stop: () => void;

  beforeEach(() => {
    testDb = createTestDb();
    const peer = dashboardPeer();
    const wired = chatsWiring(testDb.db, {
      accountOf: (channel) => (channel === "webchat" ? MAIN : null),
      platformOfChannel: () => "webchat",
      channelsOn: (on) => (on === "webchat" ? ["webchat"] : []),
    });
    const events = new ChatEvents();
    said = [];
    events.subscribe(async (event) => {
      if (event.type === "MessageSaid") said.push(event);
    });
    stop = inboundRecording(
      { chats: wired.chats, messages: wired.messages, events, adapters: wired.adapters },
      [peer.channel],
    ).listen();
    adapter = wired.adapters.of(peer.channel) as DashboardChatAdapter;
  });

  afterEach(() => {
    stop();
    testDb.close();
  });

  it("answers the browser with Rome's id once Chats has the message", async () => {
    const id = await adapter.receive({
      chat: "s1",
      key: uuid(),
      sender: { platform: "webchat", id: GUARDIAN },
      text: "hello",
      at: new Date(),
    });

    expect(id).toBeGreaterThan(0);
    expect(said.map((event) => event.message.id)).toEqual([id]);
  });

  it("records a retried send once, and raises it once", async () => {
    const send = {
      chat: "s1",
      key: uuid(),
      sender: { platform: "webchat", id: GUARDIAN },
      text: "hello",
      at: new Date(),
    };
    const first = await adapter.receive(send);
    const again = await adapter.receive(send);

    expect(first).toBeGreaterThan(0);
    // The gap: `deliver` answers null for a message on record, so the
    // adapter cannot hand the browser Rome's id for its retry. The contract
    // change is for `deliver` to answer that id too.
    expect(again).toBeNull();
    expect(said).toHaveLength(1);
  });
});
