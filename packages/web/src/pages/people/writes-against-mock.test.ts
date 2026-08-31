// @rstest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { setupServer } from "msw/node";
import type { TFunction } from "i18next";
import i18n from "@/i18n";
import { channelMirrorHandlers } from "../../../mock/handlers/people";
import { peopleHandlers } from "../../../mock/handlers/people-api";
import {
  createPerson,
  dismissAccount,
  linkAccount,
  mergePeople,
  restoreAccount,
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
