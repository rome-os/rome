import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AssignableBondLevel,
  DirectoryAccount,
  OutboxMessage,
  PersonResource,
  SendRefusal,
} from "@rome/api-types/people";
import { ACCOUNTS_KEY, OUTBOX_KEY, PEOPLE_KEY, TIMELINE_KEY } from "./use-roster";
import {
  createPerson,
  discardSend,
  dismissAccount,
  linkAccount,
  mergePeople,
  restoreAccount,
  retrySend,
  sendMessage,
  updatePerson,
  type AccountRef,
  type WriteOutcome,
} from "./writes";

// Every write the People page makes, and how one settles.
//
// A write settles by invalidation, never by patching what is cached. The page
// renders the server's rows and the server's counts, and a client that edited
// either would be rendering its own guess of what the write did — which is
// exactly the guess the contract's consolidation exists to remove, since one
// gesture can move several addresses at once and re-derive a count the reader
// then sees disagree with the next refetch.
//
// A verb resolves once that refetch has landed, not when the write returned. A
// gesture that reports itself done at the response leaves the row it acted on
// standing for as long as the read takes, which reads as a write that did
// nothing.
//
// One method per gesture the page has, which is fewer than the contract's verbs:
// unlink is `./writes.ts`'s and stays there until a gesture asks for it. This
// module is policy about settling, and there is nothing to settle for a write
// nobody makes.

export interface PeopleWrites {
  /** Create a person for an account nobody has placed, in one request. */
  place(
    account: AccountRef,
    person: { displayName: string; bondLevel: AssignableBondLevel },
  ): Promise<WriteOutcome<PersonResource>>;
  /** Link an account onto a person. `transferFrom` names the person it is taken
   *  from, which the contract requires when somebody else holds it. */
  link(
    personId: string,
    account: AccountRef,
    transferFrom?: string,
  ): Promise<WriteOutcome<PersonResource>>;
  dismiss(account: AccountRef): Promise<WriteOutcome<DirectoryAccount>>;
  restore(account: AccountRef): Promise<WriteOutcome<DirectoryAccount>>;
  /** `into` absorbs `from`, and `from` is gone. */
  merge(into: string, from: string): Promise<WriteOutcome<PersonResource>>;
  setBond(personId: string, bondLevel: AssignableBondLevel): Promise<WriteOutcome<PersonResource>>;
  /**
   * Say something to one of a person's accounts. The account is named, always —
   * the caller shows which one it picked and the request carries it.
   *
   * Answers the outbox row the send became, not a delivered message. A 409
   * carries which of the ways the channel could not be written to, so a send
   * that raced a disconnect renders the reason the composer would already have
   * shown.
   */
  say(
    personId: string,
    account: AccountRef,
    text: string,
  ): Promise<WriteOutcome<OutboxMessage, SendRefusal>>;
  /**
   * Try a failed send again, under its own outbox id.
   *
   * Refuses with a 404 for a row that is not this person's failed row — one
   * already discarded, or one a concurrent retry has claimed. Both re-read the
   * outbox, so a caller has nothing to report and nothing to undo.
   */
  retry(personId: string, messageId: string): Promise<WriteOutcome<OutboxMessage>>;
  /** Give up on a failed send. Refuses the same way {@link retry} does, and a
   *  send still in flight is not discardable — it may yet arrive. */
  discard(personId: string, messageId: string): Promise<WriteOutcome<void>>;
}

export function usePeopleWrites(): PeopleWrites {
  const { t } = useTranslation("people");
  const queryClient = useQueryClient();

  // By prefix, so one call covers the roster's people query, the dossier's
  // single-person read, the composer's shared mention cache and every cached
  // chip, term and page of the directory. The four roots are the whole of what
  // a people write can have changed.
  //
  // A send settles the same way, and settles both the outbox and the timeline:
  // a row is on exactly one of the two and the server decides which, so a
  // client that refreshed only the outbox would leave the message it just sent
  // showing as in flight until something else happened on the page.
  const settle = useCallback(
    () =>
      Promise.all(
        [PEOPLE_KEY, ACCOUNTS_KEY, TIMELINE_KEY, OUTBOX_KEY].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
    [queryClient],
  );

  return useMemo(() => {
    const settling = async <T, C>(write: () => Promise<WriteOutcome<T, C>>) => {
      const outcome = await write();
      if (outcome.ok) await settle();
      return outcome;
    };

    // The two outbox gestures settle whichever way they went.
    //
    // Every other verb here refuses by naming something the caller must then do
    // — the person who holds an account, the channel that cannot be written to
    // — so its refusal is worth surfacing and there is nothing to re-read. A
    // refused outbox gesture says only that the row is not what this page
    // thought it was: somebody else's, already discarded, or claimed by a retry
    // that won. Every one of those is answered by reading the outbox again, and
    // none of them is the guardian's to fix. Settling anyway is what keeps a
    // double-clicked Retry quiet — the loser re-reads and finds the row the
    // winner is already sending.
    const resettling = async <T, C>(write: () => Promise<WriteOutcome<T, C>>) => {
      const outcome = await write();
      await settle();
      return outcome;
    };

    // Callers hand over whatever row they are holding — a directory account, a
    // person's linked account — so the pair is projected here rather than
    // spread, and a request never carries a field the verb has no place for.
    const ref = (account: AccountRef): AccountRef => ({
      channel: account.channel,
      channelUserId: account.channelUserId,
    });

    return {
      place: (account, person) =>
        settling(() => createPerson({ ...person, accounts: [ref(account)] }, t)),
      link: (personId, account, transferFrom) =>
        settling(() =>
          linkAccount(personId, { ...ref(account), ...(transferFrom ? { transferFrom } : {}) }, t),
        ),
      dismiss: (account) => settling(() => dismissAccount(ref(account), t)),
      restore: (account) => settling(() => restoreAccount(ref(account), t)),
      merge: (into, from) => settling(() => mergePeople(into, from, t)),
      setBond: (personId, bondLevel) => settling(() => updatePerson(personId, { bondLevel }, t)),
      say: (personId, account, text) =>
        settling(() => sendMessage(personId, { ...ref(account), text }, t)),
      retry: (personId, messageId) => resettling(() => retrySend(personId, messageId, t)),
      discard: (personId, messageId) => resettling(() => discardSend(personId, messageId, t)),
    };
  }, [settle, t]);
}
