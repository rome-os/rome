// The obligations messages.ts states, as suites every store enrolls in: the
// account law every `AccountMessages` store owes, and the `query` every
// channel's `Messages` answers. One store answering them its own way is a
// preview that opens on an entry its pages never show, so the law is asserted
// once here rather than re-tested per adapter.

import { describe, expect, it } from "@rstest/core";
import {
  compareMessages,
  isAfterMessageCursor,
  messageCursor,
  type Message,
} from "@rome/api-types/message";
import type { ConversationId } from "@rome-os/app-runtime";
import type { AccountMessages, MessageAccount, Messages } from "./messages.js";

/** A limit large enough to hold any history a store can answer — what
 *  messages.ts calls the full read. */
export const WHOLE_HISTORY = Number.MAX_SAFE_INTEGER;

/** A store to run the account law against, with the accounts to run it for. */
export interface MessagesContractSubject {
  messages: AccountMessages;
  /**
   * Accounts the store holds messages for.
   *
   * Enroll with at least four messages, two of them in the same second, so the
   * ordering and cursor assertions bite: a store whose history fits in one
   * page never pages, and one whose timestamps are all distinct settles no tie.
   */
  accounts: MessageAccount[];
  /** Accounts on the store's own channels that it holds nothing for. */
  silent: MessageAccount[];
}

/** Page size the paging assertions walk with. Smaller than the history the
 *  subject owes, so exhausting it crosses at least one boundary. */
const PAGE = 2;

export function testAccountMessagesContract(
  name: string,
  subject: () => MessagesContractSubject | Promise<MessagesContractSubject>,
): void {
  describe(`Messages contract: ${name}`, () => {
    const fullRead = async ({ messages, accounts }: MessagesContractSubject) =>
      messages.read({ accounts, limit: WHOLE_HISTORY });

    it("holds enough history to prove the law", async () => {
      const store = await subject();
      const full = await fullRead(store);
      expect(full.length).toBeGreaterThanOrEqual(4);
      expect(new Set(full.map((entry) => entry.timestamp)).size).toBeLessThan(full.length);
    });

    it("answers latest as the first entry of the full read", async () => {
      const store = await subject();
      const full = await fullRead(store);
      expect(await store.messages.latest(store.accounts)).toEqual(full[0]);
    });

    it("answers count as the length of the full read", async () => {
      const store = await subject();
      const full = await fullRead(store);
      expect(await store.messages.count(store.accounts)).toBe(full.length);
    });

    it("answers latest as a read of one", async () => {
      const store = await subject();
      const page = await store.messages.read({ accounts: store.accounts, limit: 1 });
      expect(await store.messages.latest(store.accounts)).toEqual(page[0] ?? null);
    });

    it("answers a page newest first, no longer than its limit", async () => {
      const store = await subject();
      const page = await store.messages.read({ accounts: store.accounts, limit: PAGE });
      expect(page.length).toBeLessThanOrEqual(PAGE);
      expect(page).toEqual([...page].sort(compareMessages));
    });

    it("answers only messages strictly after the cursor", async () => {
      const store = await subject();
      const first = await store.messages.read({ accounts: store.accounts, limit: PAGE });
      const cursor = first.at(-1);
      if (!cursor) throw new Error("the store answered no first page to resume from");
      const next = await store.messages.read({
        accounts: store.accounts,
        after: cursor,
        limit: WHOLE_HISTORY,
      });
      expect(next.every((entry) => isAfterMessageCursor(entry, cursor))).toBe(true);
    });

    it("pages to exhaustion over exactly the full read", async () => {
      const store = await subject();
      const full = await fullRead(store);

      const walked: Message[] = [];
      let after: Message | null = null;
      // Bounded rather than `while (true)`: a store that answers the same page
      // forever fails as a wrong page count instead of hanging the suite.
      for (let page = 0; page <= Math.ceil(full.length / PAGE); page++) {
        const entries: Message[] = await store.messages.read({
          accounts: store.accounts,
          after,
          limit: PAGE,
        });
        if (entries.length === 0) break;
        walked.push(...entries);
        after = entries[entries.length - 1] ?? null;
      }

      expect(walked).toEqual(full);
    });

    it("answers nothing after the oldest message", async () => {
      const store = await subject();
      const full = await fullRead(store);
      const oldest = full.at(-1);
      expect(oldest).toBeDefined();
      const past = await store.messages.read({
        accounts: store.accounts,
        after: oldest,
        limit: WHOLE_HISTORY,
      });
      expect(past).toEqual([]);
    });

    it("gives every message its own cursor position", async () => {
      const store = await subject();
      const full = await fullRead(store);
      // Two entries that compare equal serialize to one cursor, so resuming
      // from it drops one of the pair — the pages above would never show it.
      expect(new Set(full.map(messageCursor)).size).toBe(full.length);
    });

    it("holds nothing for a silent account", async () => {
      const store = await subject();
      expect(store.silent.length).toBeGreaterThan(0);
      expect(await store.messages.latest(store.silent)).toBeNull();
      expect(await store.messages.count(store.silent)).toBe(0);
      expect(await store.messages.read({ accounts: store.silent, limit: WHOLE_HISTORY })).toEqual(
        [],
      );
    });
  });
}

/** A channel's `Messages` to run the query suite against. */
export interface MessagesQuerySubject {
  messages: Messages;
  /** The channel the store serves. */
  channel: string;
  /**
   * A conversation the store holds at least three messages of, said at no
   * fewer than two distinct times, beside at least one message in another
   * conversation. A group wherever the store can hold one, since a group is
   * what the account reads never reach.
   */
  conversation: ConversationId;
  /** A conversation on the store's channel that it holds nothing of. */
  silentConversation: ConversationId;
}

export function testMessagesQueryContract(
  name: string,
  subject: () => MessagesQuerySubject | Promise<MessagesQuerySubject>,
): void {
  describe(`Messages query contract: ${name}`, () => {
    const newestFirst = (entries: { timestamp: Date }[]) =>
      entries.every(
        (entry, index) =>
          index === 0 || entry.timestamp.getTime() <= entries[index - 1]!.timestamp.getTime(),
      );

    it("answers every conversation, newest first, as the store's channel", async () => {
      const store = await subject();
      const all = await store.messages.query({ limit: WHOLE_QUERY });
      expect(new Set(all.map((entry) => entry.conversationId)).size).toBeGreaterThan(1);
      expect(newestFirst(all)).toBe(true);
      for (const entry of all) {
        expect(entry.channel).toBe(store.channel);
        expect(["inbound", "outbound"]).toContain(entry.direction);
      }
    });

    it("answers no more than its limit, keeping the newest", async () => {
      const store = await subject();
      const all = await store.messages.query({ limit: WHOLE_QUERY });
      const page = await store.messages.query({ limit: 2 });
      expect(page).toEqual(all.slice(0, 2));
    });

    it("answers only the conversation it names", async () => {
      const store = await subject();
      const held = await store.messages.query({
        conversationId: store.conversation,
        limit: WHOLE_QUERY,
      });
      expect(held.length).toBeGreaterThanOrEqual(3);
      expect(held.every((entry) => entry.conversationId === store.conversation)).toBe(true);
      expect(newestFirst(held)).toBe(true);
    });

    it("answers only what was said at or after `since`", async () => {
      const store = await subject();
      const held = await store.messages.query({
        conversationId: store.conversation,
        limit: WHOLE_QUERY,
      });
      const times = [...new Set(held.map((entry) => entry.timestamp.getTime()))].sort(
        (a, b) => a - b,
      );
      const since = new Date(times[times.length - 1]!);
      const recent = await store.messages.query({
        conversationId: store.conversation,
        since,
        limit: WHOLE_QUERY,
      });
      expect(recent.length).toBeGreaterThan(0);
      expect(recent.length).toBeLessThan(held.length);
      expect(recent.every((entry) => entry.timestamp.getTime() >= since.getTime())).toBe(true);
    });

    // An empty list rather than a failure: a conversation the store has never
    // heard of and one it holds empty are one answer.
    it("holds nothing for a silent conversation", async () => {
      const store = await subject();
      expect(
        await store.messages.query({
          conversationId: store.silentConversation,
          limit: WHOLE_QUERY,
        }),
      ).toEqual([]);
    });
  });
}

/** The most a query answers — large enough for any subject's history. */
const WHOLE_QUERY = 1_000;
