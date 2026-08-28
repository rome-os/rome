// The obligations messages.ts states, as a suite every `Messages` adapter
// enrolls in. One store answering them its own way is a preview that opens on
// an entry its pages never show, so the law is asserted once here rather than
// re-tested per adapter.

import { describe, expect, it } from "@rstest/core";
import {
  compareTimelineEntries,
  isAfterTimelineCursor,
  timelineCursor,
  type TimelineEntry,
} from "@rome/api-types/people";
import type { MessageAccount, Messages } from "./messages.js";

/** A limit large enough to hold any history a store can answer — what
 *  messages.ts calls the full read. */
export const WHOLE_HISTORY = Number.MAX_SAFE_INTEGER;

/** A store to run the contract against, with the accounts to run it for. */
export interface MessagesContractSubject {
  messages: Messages;
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

export function testMessagesContract(
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
      expect(page).toEqual([...page].sort(compareTimelineEntries));
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
      expect(next.every((entry) => isAfterTimelineCursor(entry, cursor))).toBe(true);
    });

    it("pages to exhaustion over exactly the full read", async () => {
      const store = await subject();
      const full = await fullRead(store);

      const walked: TimelineEntry[] = [];
      let after: TimelineEntry | null = null;
      // Bounded rather than `while (true)`: a store that answers the same page
      // forever fails as a wrong page count instead of hanging the suite.
      for (let page = 0; page <= Math.ceil(full.length / PAGE); page++) {
        const entries: TimelineEntry[] = await store.messages.read({
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
      expect(new Set(full.map(timelineCursor)).size).toBe(full.length);
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
