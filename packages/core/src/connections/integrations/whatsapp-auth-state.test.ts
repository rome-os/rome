// The custom Baileys auth state (in-memory record + kit.persist
// write-through) and the one-time directory migration. Baileys' BufferJSON /
// initAuthCreds / proto are pure JS (no native deps), so this runs on the host.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import {
  createWhatsAppAuthState,
  readWhatsAppAuthStateFromDirectory,
  type WhatsAppAuthMaterial,
} from "./whatsapp-auth-state.js";

/** A macrotask flush so the microtask-debounced persist settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createWhatsAppAuthState", () => {
  it("starts from initAuthCreds() when there is no material", async () => {
    const writes: WhatsAppAuthMaterial[] = [];
    const auth = createWhatsAppAuthState(null, async (m) => {
      writes.push(m);
    });
    const fresh = initAuthCreds();
    // Same shape as a freshly-linked device (a real registrationId, no keys).
    expect(typeof auth.state.creds.registrationId).toBe("number");
    expect(Object.keys(fresh)).toEqual(expect.arrayContaining(Object.keys(auth.state.creds)));
    expect(JSON.parse(auth.serialize().keys)).toEqual({});
  });

  it("round-trips serialized material back into an identical live state", async () => {
    const first = createWhatsAppAuthState(null, async () => {});
    // Seed a key with a binary (Uint8Array) field — the BufferJSON case.
    const sessionBytes = new Uint8Array([1, 2, 3, 250, 255]);
    await first.state.keys.set({ session: { "user@s.whatsapp.net": sessionBytes } });
    const material = first.serialize();

    // Rehydrate a brand-new state from the serialized material.
    const second = createWhatsAppAuthState(material, async () => {});
    expect(second.state.creds.registrationId).toBe(first.state.creds.registrationId);

    const got = await second.state.keys.get("session", ["user@s.whatsapp.net"]);
    // Uint8Array survived as a Buffer with byte-for-byte fidelity.
    expect(Buffer.isBuffer(got["user@s.whatsapp.net"])).toBe(true);
    expect(Buffer.from(got["user@s.whatsapp.net"])).toEqual(Buffer.from(sessionBytes));
  });

  it("preserves Uint8Array fidelity through the full serialize round-trip", () => {
    const auth = createWhatsAppAuthState(null, async () => {});
    const material = auth.serialize();
    // noiseKey.private is a Uint8Array in fresh creds; it must revive as a Buffer.
    const revived = JSON.parse(material.creds, BufferJSON.reviver);
    expect(Buffer.isBuffer(revived.noiseKey.private)).toBe(true);
    expect(Buffer.from(revived.noiseKey.private)).toEqual(
      Buffer.from(auth.state.creds.noiseKey.private),
    );
  });

  it("write-throughs the MERGED material on a keys.set (debounced to one write)", async () => {
    const writes: WhatsAppAuthMaterial[] = [];
    const auth = createWhatsAppAuthState(null, async (m) => {
      writes.push(m);
    });

    // A burst of rotations within one tick (Baileys does not await between
    // them) coalesces to a single persist call…
    void auth.state.keys.set({ "pre-key": { "1": { public: new Uint8Array([9]) } as never } });
    void auth.state.keys.set({ session: { a: new Uint8Array([7]) } });
    void auth.saveCreds();
    await flush();

    expect(writes).toHaveLength(1);
    // …carrying the LATEST merged keys (both categories present).
    const persistedKeys = JSON.parse(writes[0].keys);
    expect(Object.keys(persistedKeys).sort()).toEqual(["pre-key", "session"]);
    expect(persistedKeys.session.a).toBeTruthy();
  });

  it("deletes a key when set to null (Baileys' removal signal)", async () => {
    const auth = createWhatsAppAuthState(null, async () => {});
    await auth.state.keys.set({ session: { gone: new Uint8Array([1]) } });
    await auth.state.keys.set({ session: { gone: null } });
    const got = await auth.state.keys.get("session", ["gone"]);
    expect(got.gone).toBeUndefined();
    expect(JSON.parse(auth.serialize().keys).session).toEqual({});
  });

  it("flush() persists the final rotation with no loss (stop safety)", async () => {
    const writes: WhatsAppAuthMaterial[] = [];
    const auth = createWhatsAppAuthState(null, async (m) => {
      writes.push(m);
    });

    // A rotation lands, then we flush immediately (as stop() does) BEFORE the
    // debounce microtask would have fired on its own.
    await auth.state.keys.set({ session: { final: new Uint8Array([42]) } });
    await auth.flush();

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[writes.length - 1].keys).session.final).toBeTruthy();
  });

  it("flush() with no pending write is a harmless no-op", async () => {
    const auth = createWhatsAppAuthState(null, async () => {});
    await expect(auth.flush()).resolves.toBeUndefined();
  });
});

describe("readWhatsAppAuthStateFromDirectory (migration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rome-wa-authdir-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a file the way useMultiFileAuthState does (BufferJSON.replacer). */
  async function writeStore(file: string, data: unknown): Promise<void> {
    await writeFile(join(dir, file), JSON.stringify(data, BufferJSON.replacer));
  }

  it("returns null when the directory has no creds.json", async () => {
    expect(await readWhatsAppAuthStateFromDirectory(dir)).toBeNull();
    // A missing directory is also null (never linked).
    expect(await readWhatsAppAuthStateFromDirectory(join(dir, "nope"))).toBeNull();
  });

  it("folds creds.json + every key file into serialized material", async () => {
    const creds = initAuthCreds();
    await writeStore("creds.json", creds);
    // A session key and a pre-key, mirroring the `${category}-${id}.json` layout.
    await writeStore("session-user@s.whatsapp.net.json", new Uint8Array([1, 2, 3]));
    await writeStore("pre-key-42.json", {
      public: new Uint8Array([9]),
      private: new Uint8Array([8]),
    });
    // A `sender-key-memory` file — its category prefix overlaps `sender-key`.
    await writeStore("sender-key-memory-grp@g.us.json", { "x@s.whatsapp.net": true });

    const material = await readWhatsAppAuthStateFromDirectory(dir);
    expect(material).not.toBeNull();

    // Rehydrating the material yields the same registrationId + keys.
    const state = createWhatsAppAuthState(material, async () => {});
    expect(state.state.creds.registrationId).toBe(creds.registrationId);

    const sess = await state.state.keys.get("session", ["user@s.whatsapp.net"]);
    expect(Buffer.from(sess["user@s.whatsapp.net"])).toEqual(Buffer.from([1, 2, 3]));

    const keys = JSON.parse(material!.keys);
    expect(Object.keys(keys).sort()).toEqual(["pre-key", "sender-key-memory", "session"]);
    // sender-key-memory won over sender-key (longest-prefix match), id intact.
    expect(keys["sender-key-memory"]["grp@g.us"]).toEqual({ "x@s.whatsapp.net": true });
  });

  it("leaves the source directory intact (rollback safety)", async () => {
    const { readdir } = await import("node:fs/promises");
    await writeStore("creds.json", initAuthCreds());
    await writeStore("session-a.json", new Uint8Array([1]));
    await readWhatsAppAuthStateFromDirectory(dir);
    const files = await readdir(dir);
    expect(files.sort()).toEqual(["creds.json", "session-a.json"]);
  });
});
