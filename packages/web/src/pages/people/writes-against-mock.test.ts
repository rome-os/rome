// @rstest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { setupServer } from "msw/node";
import type { TFunction } from "i18next";
import i18n from "@/i18n";
import { channelMirrorHandlers } from "../../../mock/handlers/people";
import { peopleHandlers } from "../../../mock/handlers/people-api";
import type { OutboxPage } from "@rome/api-types/people";
import { fetchJson } from "@/lib/fetch-json";
import {
  createPerson,
  discardSend,
  dismissAccount,
  linkAccount,
  mergePeople,
  restoreAccount,
  retrySend,
  sendMessage,
  unlinkAccount,
  updatePerson,
} from "./writes";

// The page's own write functions against a backend that implements the /people
// contract, rather than against a stub written from the same reading of it.
//
// `writes.test.ts` pins the request each verb sends. That leaves one thing it
// cannot see: whether the request a route can answer is the request this client
// builds. An account identifier is escaped into the path — a WhatsApp jid
// carries an `@`, and channels are free to mint worse — so the escaping and the
// decoding have to agree, and a test that asserts a URL string proves only that
// the client is self-consistent.

const server = setupServer(...peopleHandlers, ...channelMirrorHandlers);

beforeAll(async () => {
  await i18n.changeLanguage("en");
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());

const t = i18n.getFixedT("en", "people") as TFunction<"people">;

// Fixtures from the mock store: an unlinked WhatsApp sender (whose jid is the
// escaping case) and an unlinked Telegram one.
const DEVIKA = { channel: "whatsapp", channelUserId: "447700900812@s.whatsapp.net" };
const JULES = { channel: "telegram", channelUserId: "883104221" };

describe("People writes, against the contract's own handlers", () => {
  it("dismisses and restores an account whose identifier needs escaping", async () => {
    const dismissed = await dismissAccount(DEVIKA, t);
    expect(dismissed).toMatchObject({ ok: true, value: { state: "dismissed" } });

    const restored = await restoreAccount(DEVIKA, t);
    expect(restored).toMatchObject({ ok: true, value: { state: "unlinked" } });
  });

  it("creates a person and links the account it came from, in one request", async () => {
    const created = await createPerson(
      { displayName: "Devika Rao", bondLevel: "acquaintance", accounts: [DEVIKA] },
      t,
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.accounts).toContainEqual(expect.objectContaining(DEVIKA));

    // And the same identifier addresses the account for the unlink that undoes
    // it, through a route that takes it from the path rather than a body.
    const unlinked = await unlinkAccount(created.value.id, DEVIKA, t);
    expect(unlinked.ok).toBe(true);
    if (!unlinked.ok) return;
    expect(unlinked.value.accounts).toHaveLength(0);
  });

  it("refuses a link the contract holds, and takes it on the transfer", async () => {
    const holder = await createPerson({ displayName: "Jules Holder", accounts: [JULES] }, t);
    const taker = await createPerson({ displayName: "Jules Taker" }, t);
    expect(holder.ok && taker.ok).toBe(true);
    if (!holder.ok || !taker.ok) return;

    const refused = await linkAccount(taker.value.id, JULES, t);
    expect(refused.ok).toBe(false);
    if (refused.ok || !("conflict" in refused)) throw new Error("expected a conflict");
    // The refusal names the holder, which is the whole reason the page can
    // offer a transfer by name instead of reporting a failed write.
    expect(refused.conflict.linkedPersonId).toBe(holder.value.id);
    expect(refused.conflict.linkedPersonName).toBe("Jules Holder");

    const taken = await linkAccount(taker.value.id, { ...JULES, transferFrom: holder.value.id }, t);
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.value.accounts).toContainEqual(expect.objectContaining(JULES));
  });

  it("changes a bond and absorbs a duplicate", async () => {
    const survivor = await createPerson({ displayName: "Mira Survivor" }, t);
    const duplicate = await createPerson({ displayName: "Mira Duplicate" }, t);
    expect(survivor.ok && duplicate.ok).toBe(true);
    if (!survivor.ok || !duplicate.ok) return;

    const patched = await updatePerson(survivor.value.id, { bondLevel: "inner-circle" }, t);
    expect(patched).toMatchObject({ ok: true, value: { bondLevel: "inner-circle" } });

    const merged = await mergePeople(survivor.value.id, duplicate.value.id, t);
    expect(merged).toMatchObject({ ok: true, value: { id: survivor.value.id } });
  });
});

// The send verbs, against the same handlers.
//
// The outbox is the one read on this surface that clears itself, and it clears
// by comparing its rows against the timeline rather than by being told. A client
// asserting that against a stub of its own would only be asserting its own
// reading of the rule; this asserts it against something that implements it.

const RAY = "ray-oster";
/** Ray's Telegram account, which the fixture ledger can be written to. */
const RAY_TELEGRAM = { channel: "telegram", channelUserId: "418820113" };
/** Arvind's LinkedIn account: a live connection whose talker does no direct
 *  messaging, which is the `unsupported` refusal. */
const ARVIND = { channel: "linkedin", channelUserId: "ACoAAArvind01" };

const readOutbox = (personId: string) =>
  fetchJson<OutboxPage>(`/api/people/${personId}/outbox`, { fallback: "outbox unavailable" });

/** Read the outbox until it answers what the caller is waiting for — the same
 *  poll a reader of the page makes, and the read that clears a landed row. */
async function outboxUntil(
  personId: string,
  done: (page: OutboxPage) => boolean,
): Promise<OutboxPage> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const page = await readOutbox(personId);
    if (done(page)) return page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the outbox never reached the state under test");
}

const holds = (page: OutboxPage, id: string) => page.messages.some((m) => m.id === id);

describe("Sending, against the contract's own handlers", () => {
  it("holds a send in the outbox, and lets it go once it is on the timeline", async () => {
    const sent = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "on my way" }, t);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    // Never delivered on the way out: the channel taking a message is not the
    // message arriving, and the body says which of the two has happened.
    expect(sent.value.state).toBe("sending");

    const inFlight = await outboxUntil(RAY, (page) => holds(page, sent.value.id));
    expect(inFlight.messages.find((m) => m.id === sent.value.id)?.text).toBe("on my way");

    // And it leaves on its own. Nothing cleared it — the read compared the two
    // stores and found the message in the other one.
    await outboxUntil(RAY, (page) => !holds(page, sent.value.id));

    const timeline = await fetchJson<{ entries: { body: string | null }[] }>(
      `/api/people/${RAY}/messages`,
      { fallback: "timeline unavailable" },
    );
    expect(timeline.entries.some((entry) => entry.body === "on my way")).toBe(true);
  });

  it("keeps a refused send, and clears it on a retry that reuses the row", async () => {
    const sent = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "fail this one" }, t);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const failed = await outboxUntil(RAY, (page) =>
      page.messages.some((m) => m.id === sent.value.id && m.state === "failed"),
    );
    // The channel's own words, shown as detail under copy the dashboard owns.
    expect(failed.messages.find((m) => m.id === sent.value.id)?.error).toBeTruthy();

    const retried = await retrySend(RAY, sent.value.id, t);
    expect(retried).toMatchObject({ ok: true, value: { id: sent.value.id } });

    // The same row throughout, so a retry never reads as a second message the
    // guardian did not write.
    await outboxUntil(RAY, (page) => !holds(page, sent.value.id));
  });

  it("discards a refused send — the one way a row leaves undelivered", async () => {
    const sent = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "fail and forget" }, t);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    await outboxUntil(RAY, (page) =>
      page.messages.some((m) => m.id === sent.value.id && m.state === "failed"),
    );
    expect(await discardSend(RAY, sent.value.id, t)).toMatchObject({ ok: true });
    expect(holds(await readOutbox(RAY), sent.value.id)).toBe(false);
  });

  it("refuses a channel that cannot be written to, naming which refusal it is", async () => {
    const refused = await sendMessage("arvind-srivastav", { ...ARVIND, text: "hello" }, t);
    expect(refused.ok).toBe(false);
    if (refused.ok || !("conflict" in refused)) throw new Error("expected a refusal");
    // The state, not a sentence. That is what lets the dashboard localize the
    // reason, and say the same thing whether it read it or raced it.
    expect(refused.conflict.send).toBe("unsupported");
  });

  it("lets one of two retries of a row win, so a double click sends once", async () => {
    const sent = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "fail then retry twice" }, t);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    await outboxUntil(RAY, (page) =>
      page.messages.some((m) => m.id === sent.value.id && m.state === "failed"),
    );

    // Both reach the route; the state is what claims the row, so the second
    // finds a row that is no longer theirs to send. Sending the guardian's
    // message twice is the exact harm the outbox is arranged around.
    const [first, second] = await Promise.all([
      retrySend(RAY, sent.value.id, t),
      retrySend(RAY, sent.value.id, t),
    ]);
    expect([first!.ok, second!.ok].filter(Boolean)).toHaveLength(1);
  });

  it("refuses a retry of a row still in flight, and a discard of one too", async () => {
    const sent = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "still going" }, t);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    // A send that may yet arrive is not the guardian's to retry or to drop the
    // record of — losing it would leave them with no account of the message.
    expect(await retrySend(RAY, sent.value.id, t)).toMatchObject({ ok: false });
    expect(await discardSend(RAY, sent.value.id, t)).toMatchObject({ ok: false });
    await outboxUntil(RAY, (page) => !holds(page, sent.value.id));
  });

  it("lets a delivered-but-unseen send be discarded once it is past the window", async () => {
    // The phantom the rule exists for: the channel took it, the message never
    // reached the timeline, and nothing will ever move the row. On a channel
    // with no mirror of its own this is the only way out it has.
    const sent = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "wedged forever" }, t);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const stuck = await outboxUntil(RAY, (page) =>
      page.messages.some((m) => m.id === sent.value.id && m.state === "unconfirmed"),
    );
    expect(stuck.messages.find((m) => m.id === sent.value.id)?.error).toBeNull();

    // Not retryable — a refusal is what can be tried again, and this was
    // accepted — but dismissable, because it has outlived the landing window.
    expect(await retrySend(RAY, sent.value.id, t)).toMatchObject({ ok: false });
    expect(await discardSend(RAY, sent.value.id, t)).toMatchObject({ ok: true });
    expect(holds(await readOutbox(RAY), sent.value.id)).toBe(false);
  });

  it("refuses an outbox row of somebody else's, reached through this person", async () => {
    const sent = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "fail for the scope check" }, t);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    await outboxUntil(RAY, (page) =>
      page.messages.some((m) => m.id === sent.value.id && m.state === "failed"),
    );

    // A message id is not a capability. The person in the path is whose outbox
    // it is, and Ray's row is not reachable through Sam's.
    expect(await retrySend("sam-okafor", sent.value.id, t)).toMatchObject({ ok: false });
    expect(await discardSend("sam-okafor", sent.value.id, t)).toMatchObject({ ok: false });
    expect(holds(await readOutbox(RAY), sent.value.id)).toBe(true);
    await discardSend(RAY, sent.value.id, t);
  });

  it("refuses an account the person does not hold, before anything is sent", async () => {
    // Not a refusal about a channel — a request this person's page cannot
    // answer, and sending anyway would deliver a message addressed to someone
    // else.
    const refused = await sendMessage(RAY, { ...ARVIND, text: "hello" }, t);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect("conflict" in refused).toBe(false);
  });
});
