// The Chats and adapter eval: checks Q1–Q6 at the boundary between Chats and
// each platform's adapter, and writes what holds to out/boundary.json for the
// scorecard. Most checks drive `ChatAdapter` (`start`, `deliver`, `fault`,
// `send`) with a stand-in for Chats and read only what crosses it, so they
// keep working as adapters are rewritten. Faults are injected at the
// connection's inbound port, just below the adapter. The qualities are
// defined in the report "Chats and adapters: patterns and interface gaps".

import { afterAll, describe, it } from "@rstest/core";
import {
  type Channel,
  type ChatId,
  type InboundEvent,
  isSendRefused,
  type OutgoingMessage,
} from "@rome-os/app-runtime";
import { chatsWiring } from "../../../chats-wiring.js";
import type { ChannelSend } from "../../../chats/connected-accounts/connected-account.js";
import { ChatEvents, type MessageSaid } from "../../../chats/storage/events.js";
import type { ChannelChatAdapter, Inbound } from "../../../connections/chat-adapter.js";
import { inboundRecording } from "../../../connections/inbound-recording.js";
import type { ConformanceChannel } from "../../kit/im/adapter-conformance.js";
import { createTestDb, type TestDb } from "../../helpers.js";
import { type EvalPlatform, PLATFORMS } from "./platforms.js";
import { check, expectThat, writeOutcomes } from "./results.js";

const WAIT_MS = 3_000;
/** How long a check waits for something that should not happen. */
const QUIET_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(holds: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * `channel` with its inbound port passed through, so a check can hand the
 * adapter an event again or a made-up one, as a reconnect or a platform would.
 */
function seam(channel: Channel) {
  const inbound = channel.inbound;
  if (!inbound) throw new Error(`Channel "${channel.name}" hears nothing`);
  const handlers = new Set<(event: InboundEvent) => Promise<void>>();
  const seen: InboundEvent[] = [];
  let unsubscribe: (() => void) | null = null;
  const passThrough = async (event: InboundEvent) => {
    for (const handler of [...handlers]) await handler(event);
  };
  const wrapped: Channel = {
    name: channel.name,
    send: channel.send,
    inbound: {
      subscribe(handler) {
        unsubscribe ??= inbound.subscribe(async (event) => {
          seen.push(event);
          await passThrough(event);
        });
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
      media: inbound.media,
    },
  };
  return {
    channel: wrapped,
    /** Every event the platform delivered, oldest first. */
    seen,
    /** Hand `event` to the adapter again, below it. */
    replay: passThrough,
    close: () => unsubscribe?.(),
  };
}

/** One platform's adapter, started with a stand-in for Chats that answers
 *  every message with a fresh id. */
async function boundary(platform: EvalPlatform) {
  const testDb = createTestDb();
  const peer = await platform.start();
  const port = seam(peer.channel);
  const name = port.channel.name;
  const on = peer.account.platform;
  const wired = chatsWiring(testDb.db, {
    accountOf: (channel) => (channel === name ? peer.account : null),
    platformOfChannel: () => on,
    channelsOn: (asked) => (asked === on ? [name] : []),
  });
  const adapter: ChannelChatAdapter = wired.adapters.of(port.channel);
  const delivered: Inbound[] = [];
  const faults: Error[] = [];
  let nextId = 1;
  const deliver = async (message: Inbound) => {
    delivered.push(message);
    return nextId++;
  };
  const fault = (error: Error) => {
    faults.push(error);
  };
  adapter.start(deliver, fault);

  /** The conversation the checks that need only one run in. */
  const conversation = peer.direct ?? peer.group;
  if (!conversation) throw new Error(`${platform.name} models no conversation`);

  /** The person writes `text`; resolves with what the adapter handed over. */
  const personSays = async (
    text: string,
    writes: (said: string) => string | Promise<string> = (said) => conversation.personWrites(said),
  ) => {
    const before = delivered.length;
    const platformId = await writes(text);
    await until(() => delivered.length > before, `"${text}" to reach deliver`);
    return { inbound: delivered[before]!, platformId };
  };

  return {
    peer,
    port,
    adapter,
    delivered,
    faults,
    deliver,
    fault,
    conversation,
    personSays,
    close: async () => {
      await adapter.stop();
      port.close();
      await peer.stop();
      testDb.close();
    },
  };
}

/** One platform wired as production wires it: inbound recording into Chats,
 *  and sends at an address through the hook send path. For the checks whose
 *  outcome is what Chats ends up holding. */
async function recorded(platform: EvalPlatform) {
  const testDb: TestDb = createTestDb();
  const peer: ConformanceChannel = await platform.start();
  const on = peer.account.platform;
  const wired = chatsWiring(testDb.db, {
    accountOf: (channel) => (channel === peer.channel.name ? peer.account : null),
    platformOfChannel: () => on,
    channelsOn: (asked) => (asked === on ? [peer.channel.name] : []),
  });
  const events = new ChatEvents();
  const said: MessageSaid[] = [];
  events.subscribe(async (event) => {
    if (event.type === "MessageSaid") said.push(event);
  });
  const stopRecording = inboundRecording(
    { chats: wired.chats, messages: wired.messages, events, adapters: wired.adapters },
    [peer.channel],
  ).listen();
  const [hookChannel] = wired.recordedSends([peer.channel]);
  const send = (address: string, message: OutgoingMessage) =>
    (hookChannel!.send as ChannelSend).send(address as ChatId, message);
  return {
    peer,
    said,
    send,
    chatsHeld: () => wired.chats.list(on),
    close: async () => {
      stopRecording();
      await peer.stop();
      testDb.close();
    },
  };
}

type Boundary = Awaited<ReturnType<typeof boundary>>;

/** Run `body` against a fresh boundary for `platform`, closing it after. */
async function on(platform: EvalPlatform, body: (at: Boundary) => Promise<void>): Promise<void> {
  const at = await boundary(platform);
  try {
    await body(at);
  } finally {
    await at.close();
  }
}

for (const platform of PLATFORMS) {
  const name = platform.name;
  const { models } = platform;

  describe(`chats adapter eval: ${name}`, () => {
    it("Q1 nothing is lost quietly", async () => {
      await check("Q1", name, "an empty inbound message is handed over or reported", () =>
        on(platform, async (at) => {
          await at.personSays("hello Rome");
          const heard = at.port.seen.at(-1)!;
          const deliveredBefore = at.delivered.length;
          const faultsBefore = at.faults.length;
          await at.port.replay({
            ...heard,
            message: {
              ...heard.message,
              messageId: `${heard.message.messageId}-empty`,
              text: "",
              attachments: [],
            },
          });
          await sleep(QUIET_MS);
          expectThat(
            at.delivered.length > deliveredBefore || at.faults.length > faultsBefore,
            "the adapter neither handed the message to deliver nor reported it through fault",
          );
        }),
      );

      await check("Q1", name, "a send that says nothing is refused with a typed reason", () =>
        on(platform, async (at) => {
          const { inbound } = await at.personSays("hello Rome");
          const sent = await at.adapter
            .send(inbound.chat.externalId, inbound.thread?.id ?? null, { text: "" })
            .then(
              () => null,
              (error: unknown) => error,
            );
          expectThat(sent !== null, "the empty send went out");
          expectThat(
            isSendRefused(sent),
            `the empty send failed without a typed refusal: ${String(sent)}`,
          );
        }),
      );

      await check("Q1", name, "a send the platform refuses fails, rather than resolving", () =>
        on(platform, async (at) => {
          const { inbound } = await at.personSays("hello Rome");
          at.peer.refuseNextSend();
          const failed = await at.adapter
            .send(inbound.chat.externalId, inbound.thread?.id ?? null, { text: "lost" })
            .then(
              () => false,
              () => true,
            );
          expectThat(failed, "the refused send resolved as sent");
        }),
      );
    });

    it("Q2 handed over exactly once", async () => {
      await check("Q2", name, "a message the connection delivers twice reaches deliver once", () =>
        on(platform, async (at) => {
          const { inbound } = await at.personSays("only once");
          await at.port.replay(at.port.seen.at(-1)!);
          await sleep(QUIET_MS);
          const copies = at.delivered.filter(
            (message) =>
              message.chat.externalId === inbound.chat.externalId && message.key === inbound.key,
          ).length;
          expectThat(copies === 1, `deliver was called ${copies} times for one message`);
        }),
      );

      await check(
        "Q2",
        name,
        "a message delivered again after the adapter restarts reaches deliver once",
        () =>
          on(platform, async (at) => {
            const { inbound } = await at.personSays("only once, across a restart");
            const heard = at.port.seen.at(-1)!;
            await at.adapter.stop();
            at.adapter.start(at.deliver, at.fault);
            await at.port.replay(heard);
            await sleep(QUIET_MS);
            const copies = at.delivered.filter(
              (message) =>
                message.chat.externalId === inbound.chat.externalId && message.key === inbound.key,
            ).length;
            expectThat(copies === 1, `deliver was called ${copies} times for one message`);
          }),
      );
    });

    it("Q3 ordered", async () => {
      await check("Q3", name, "a chat's messages reach deliver in the platform's order", () =>
        on(platform, async (at) => {
          const texts = ["one", "two", "three", "four", "five"];
          for (const text of texts) await at.conversation.personWrites(text);
          await until(
            () => at.delivered.length >= texts.length,
            "five messages to reach deliver",
          ).catch((error: Error) => {
            const got = JSON.stringify(at.delivered.map((message) => message.text));
            throw new Error(`${error.message}; deliver saw ${got}`);
          });
          const order = at.delivered.map((message) => message.text);
          expectThat(
            JSON.stringify(order) === JSON.stringify(texts),
            `deliver saw ${JSON.stringify(order)}`,
          );
        }),
      );
    });

    it("Q4 same conversation, same chat", async () => {
      await check("Q4", name, "a reply to a message lands where the person sees it", () =>
        on(platform, async (at) => {
          const { inbound } = await at.personSays("hello Rome");
          await at.adapter.send(inbound.chat.externalId, inbound.thread?.id ?? null, {
            text: "hello back",
          });
          const last = at.peer.visible(at.conversation.at).at(-1);
          expectThat(
            last?.from === "rome" && last.text === "hello back",
            `the person sees ${JSON.stringify(last)} last`,
          );
        }),
      );

      await check(
        "Q4",
        name,
        "a direct message Rome opens is the chat the person answers in",
        async () => {
          const at = await recorded(platform);
          try {
            await at.send(at.peer.direct!.person, { text: "Rome writes first" });
            const before = at.said.length;
            await at.peer.direct!.personWrites("and the person answers");
            await until(() => at.said.length > before, "the answer to be recorded");
            const held = at.chatsHeld().map((chat) => chat.kind);
            expectThat(
              held.length === 1 && held[0] === "dm",
              `Chats holds ${JSON.stringify(held)} for one direct conversation`,
            );
          } finally {
            await at.close();
          }
        },
        models.directMessages && models.romeWritesFirst,
      );
    });

    it("Q5 one truth", async () => {
      await check(
        "Q5",
        name,
        "a direct message is stated as one",
        () =>
          on(platform, async (at) => {
            const { inbound } = await at.personSays("hello Rome", (text) =>
              at.peer.direct!.personWrites(text),
            );
            expectThat(inbound.chatKind === "dm", `stated as ${inbound.chatKind}`);
          }),
        models.directMessages,
      );

      await check(
        "Q5",
        name,
        "a group message is stated as one",
        () =>
          on(platform, async (at) => {
            const { inbound } = await at.personSays("hello all", (text) =>
              at.peer.group!.personWrites(text),
            );
            expectThat(inbound.chatKind === "group", `stated as ${inbound.chatKind}`);
          }),
        models.groups,
      );

      await check(
        "Q5",
        name,
        "a thread's message is stated as said in that thread",
        () =>
          on(platform, async (at) => {
            const { inbound } = await at.personSays("plans?", (text) =>
              at.peer.thread!.personWrites(text),
            );
            expectThat(
              inbound.thread?.id === at.peer.thread!.at,
              `stated as said in ${JSON.stringify(inbound.thread)}`,
            );
          }),
        models.threads,
      );
    });

    it("Q6 declared equals actual", async () => {
      await check(
        "Q6",
        name,
        "a quote is made, or refused with a typed reason, never dropped",
        () =>
          on(platform, async (at) => {
            const { inbound, platformId } = await at.personSays("which day?");
            const refused = await at.adapter
              .send(inbound.chat.externalId, inbound.thread?.id ?? null, {
                text: "Tuesday",
                replyTo: inbound.key,
              })
              .then(
                () => null,
                (error: unknown) => error,
              );
            if (refused !== null) {
              expectThat(
                isSendRefused(refused),
                `failed without a typed refusal: ${String(refused)}`,
              );
              return;
            }
            const last = at.peer.visible(at.conversation.at).at(-1);
            expectThat(
              last?.text === "Tuesday" && last.replyTo === platformId,
              "the reply went out without its quote",
            );
          }),
      );
    });
  });
}

afterAll(() => {
  writeOutcomes("boundary.json");
});
