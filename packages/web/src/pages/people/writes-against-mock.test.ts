// @rstest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { setupServer } from "msw/node";
import type { TFunction } from "i18next";
import i18n from "@/i18n";
import { peopleHandlers } from "../../../mock/handlers/people-api";
import type { TimelinePage } from "@rome/api-types/people";
import { fetchJson } from "@/lib/fetch-json";
import {
  createPerson,
  deletePerson,
  dismissAccount,
  linkAccount,
  mergePeople,
  restoreAccount,
  sendMessage,
  updatePerson,
} from "./writes";

// The page's own write functions against a backend that implements the /people
// contract, rather than against a stub written from the same reading of it.
//
// This is where the request each verb sends is checked: whether the request a
// route can answer is the request this client builds. An account identifier is
// escaped into the path — a WhatsApp jid carries an `@`, and channels are free
// to mint worse — so the escaping and the decoding have to agree, and a test
// that asserts a URL string proves only that the client is self-consistent.

const server = setupServer(...peopleHandlers);

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

  it("carries a delegate link's mark when the account is moved to someone else", async () => {
    const agent = { channel: "agents", channelUserId: "agt_atlas" };
    const taker = await createPerson({ displayName: "Atlas Owner" }, t);
    expect(taker.ok).toBe(true);
    if (!taker.ok) return;

    const moved = await linkAccount(taker.value.id, { ...agent, transferFrom: "mock-guardian" }, t);

    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.accounts).toContainEqual(
      expect.objectContaining({ ...agent, delegate: true }),
    );
  });

  it("deletes a person, leaving their account free to link again, and keeps the guardian", async () => {
    const account = { channel: "telegram", channelUserId: "990001" };
    const doomed = await createPerson({ displayName: "Nell Deleted", accounts: [account] }, t);
    const other = await createPerson({ displayName: "Nell Other" }, t);
    expect(doomed.ok && other.ok).toBe(true);
    if (!doomed.ok || !other.ok) return;

    expect(await deletePerson(doomed.value.id, t)).toMatchObject({ ok: true });
    expect(await deletePerson(doomed.value.id, t)).toMatchObject({ ok: false, status: 404 });
    // A stranger again: linking it needs no transfer from anybody.
    const relinked = await linkAccount(other.value.id, account, t);
    expect(relinked.ok).toBe(true);

    expect(await deletePerson("mock-guardian", t)).toMatchObject({
      ok: false,
      message: "the guardian cannot be deleted",
      status: 400,
    });
  });
});

// The send verb, against the same handlers: one call that answers once the
// channel took the message, with Rome's copy already on the timeline, or with
// the channel's refusal.

const RAY = "ray-oster";
/** Ray's Telegram account, which the fixture ledger can be written to. */
const RAY_TELEGRAM = { channel: "telegram", channelUserId: "418820113" };
/** Arvind's LinkedIn account: a live connection whose talker does no direct
 *  messaging, which is the `unsupported` refusal. */
const ARVIND = { channel: "linkedin", channelUserId: "ACoAAArvind01" };

const timelineOf = (personId: string) =>
  fetchJson<TimelinePage>(`/api/people/${personId}/messages`, {
    fallback: "timeline unavailable",
  });

describe("Sending, against the contract's own handlers", () => {
  it("answers once the channel took it, with the message already on the timeline", async () => {
    const sent = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "on my way" }, t);
    expect(sent).toMatchObject({ ok: true, value: { ref: expect.any(String) } });

    const timeline = await timelineOf(RAY);
    expect(timeline.entries.filter((entry) => entry.body === "on my way")).toHaveLength(1);
  });

  it("answers a refused send with the channel's words, and keeps nothing", async () => {
    const refused = await sendMessage(RAY, { ...RAY_TELEGRAM, text: "fail this one" }, t);
    expect(refused).toEqual({
      ok: false,
      message: "the channel rejected this message",
      status: 502,
    });
    expect((await timelineOf(RAY)).entries.some((e) => e.body === "fail this one")).toBe(false);

    // A retry is the same request again, and this time it goes through.
    expect(await sendMessage(RAY, { ...RAY_TELEGRAM, text: "fail this one" }, t)).toMatchObject({
      ok: true,
    });
    expect((await timelineOf(RAY)).entries.some((e) => e.body === "fail this one")).toBe(true);
  });

  it("sends a LinkedIn reply onto the shared timeline", async () => {
    const sent = await sendMessage("arvind-srivastav", { ...ARVIND, text: "LinkedIn reply" }, t);
    expect(sent.ok).toBe(true);
    const timeline = await timelineOf("arvind-srivastav");
    expect(timeline.entries.some((entry) => entry.body === "LinkedIn reply")).toBe(true);
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
