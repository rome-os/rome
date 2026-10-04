// Store-key derivation and checking against a stand-in encrypted store
// (wechat-user-store-fixture.ts), in a temp home.

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import {
  checkStoreKeys,
  deriveStoreKeys,
  migrateLegacyStoreKeys,
  WechatStoreKeysError,
} from "./wechat-user-store-keys.js";
import { pageKey, STORE_DATABASES, writeStore } from "./wechat-user-store-fixture.js";

const PASSPHRASE = randomBytes(32);
const SALT = randomBytes(16);
// One salt for the whole store, so the 256000-round derivation runs once.
const ENC_KEY = pageKey(PASSPHRASE, SALT);

let home: string;
let accountDir: string;
let dbDir: string;
let keysFile: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wechat-store-keys-"));
  accountDir = join(home, "xwechat_files", "wxid_guardian");
  dbDir = join(accountDir, "db_storage");
  keysFile = join(home, "bridge", "keys.json");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function expectKind(promise: Promise<unknown>, kind: WechatStoreKeysError["kind"]) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WechatStoreKeysError);
  expect((error as WechatStoreKeysError).kind).toBe(kind);
}

describe("deriveStoreKeys", () => {
  it("writes every database's key in the bridge's file, private to the runtime user", async () => {
    await writeStore(dbDir, ENC_KEY, SALT);
    const result = await deriveStoreKeys(PASSPHRASE.toString("hex"), { accountDir, keysFile });

    expect(result).toEqual({ derived: 4, databases: 4, wxid: "wxid_guardian" });
    const stored = JSON.parse(await readFile(keysFile, "utf8"));
    expect(stored).toMatchObject({ dbDir, wxid: "wxid_guardian" });
    expect(Object.keys(stored.keys).sort()).toEqual([...STORE_DATABASES].sort());
    expect(stored.keys["message/message_0.db"]).toEqual({
      encKey: ENC_KEY.toString("hex"),
      salt: SALT.toString("hex"),
      sizeMb: 0,
    });
    expect((await stat(keysFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "bridge"))).mode & 0o777).toBe(0o700);
    await checkStoreKeys({ accountDir, keysFile });
  });

  it("waits while the client has not created a message shard yet", async () => {
    await writeStore(dbDir, ENC_KEY, SALT, ["session/session.db", "contact/contact.db"]);
    await expectKind(
      deriveStoreKeys(PASSPHRASE.toString("hex"), { accountDir, keysFile }),
      "pending",
    );
    await expect(stat(keysFile)).rejects.toThrow();
  });

  it("waits while a required database is still being written", async () => {
    await writeStore(dbDir, ENC_KEY, SALT, ["session/session.db", "message/message_0.db"]);
    await mkdir(join(dbDir, "contact"), { recursive: true });
    await writeFile(join(dbDir, "contact", "contact.db"), Buffer.alloc(100));
    await expectKind(
      deriveStoreKeys(PASSPHRASE.toString("hex"), { accountDir, keysFile }),
      "pending",
    );
  });

  it("rejects a passphrase that opens nothing, and a signed-out account", async () => {
    await writeStore(dbDir, ENC_KEY, SALT);
    await expectKind(
      deriveStoreKeys(randomBytes(32).toString("hex"), { accountDir, keysFile }),
      "rejected",
    );
    await expectKind(deriveStoreKeys("not hex", { accountDir, keysFile }), "rejected");
    await expectKind(
      deriveStoreKeys(PASSPHRASE.toString("hex"), { accountDir: null, keysFile }),
      "rejected",
    );
  });
});

describe("checkStoreKeys", () => {
  it("rejects missing keys, another account's keys, and keys that stopped fitting", async () => {
    const keys = await writeStore(dbDir, ENC_KEY, SALT);
    await expectKind(checkStoreKeys({ accountDir, keysFile }), "rejected");

    await mkdir(join(home, "bridge"), { recursive: true });
    await writeFile(keysFile, JSON.stringify({ dbDir: "/elsewhere", wxid: "x", keys }));
    await expectKind(checkStoreKeys({ accountDir, keysFile }), "rejected");

    // The client re-keyed a shard after the keys were stored.
    await writeFile(keysFile, JSON.stringify({ dbDir, wxid: "wxid_guardian", keys }));
    await writeStore(dbDir, randomBytes(32), SALT, ["message/message_0.db"]);
    await expectKind(checkStoreKeys({ accountDir, keysFile }), "rejected");
  });
});

describe("migrateLegacyStoreKeys", () => {
  const legacyDir = () => join(home, ".wechat-cli");

  async function writeLegacy(
    dbDirInConfig: string,
    keys: Record<string, { encKey: string; salt: string }>,
  ) {
    await mkdir(legacyDir(), { recursive: true });
    await writeFile(join(legacyDir(), "config.json"), JSON.stringify({ db_dir: dbDirInConfig }));
    const legacy = Object.fromEntries(
      Object.entries(keys).map(([rel, k]) => [
        rel,
        { enc_key: k.encKey, salt: k.salt, size_mb: 1.5 },
      ]),
    );
    await writeFile(join(legacyDir(), "all_keys.json"), JSON.stringify(legacy));
  }

  it("carries the Python reader's keys into the bridge's file", async () => {
    await writeLegacy(dbDir, await writeStore(dbDir, ENC_KEY, SALT));
    expect(await migrateLegacyStoreKeys(legacyDir(), { accountDir, keysFile })).toBe(true);
    await checkStoreKeys({ accountDir, keysFile });
    const stored = JSON.parse(await readFile(keysFile, "utf8"));
    expect(stored.keys["session/session.db"].sizeMb).toBe(1.5);
    // Once the bridge's file exists, the old keys are never read again.
    expect(await migrateLegacyStoreKeys(legacyDir(), { accountDir, keysFile })).toBe(false);
  });

  it("leaves another account's or stale keys behind", async () => {
    const keys = await writeStore(dbDir, ENC_KEY, SALT);
    await writeLegacy("/home/rome/xwechat_files/wxid_other/db_storage", keys);
    expect(await migrateLegacyStoreKeys(legacyDir(), { accountDir, keysFile })).toBe(false);

    // The client re-keyed the contact list since the old keys were stored.
    await writeStore(dbDir, randomBytes(32), SALT, ["contact/contact.db"]);
    await writeLegacy(dbDir, keys);
    expect(await migrateLegacyStoreKeys(legacyDir(), { accountDir, keysFile })).toBe(false);
    await expect(stat(keysFile)).rejects.toThrow();
  });
});
