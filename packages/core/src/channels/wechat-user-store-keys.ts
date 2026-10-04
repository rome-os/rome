// WeChat message-store keys. Channel contract: docs/architecture/channels.md.
//
// Rome captures the store passphrase itself (wechat-user-keys.ts) and turns it
// into per-database keys here, written in the file `wechat-bridge` reads. The
// bridge's own `init` derives once, right after capture, and drops the
// passphrase, so a database the client creates a moment later would stay
// locked until another capture. Deriving here keeps the passphrase for as long
// as the setup waits.

import { createHmac, pbkdf2, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const PAGE_SIZE = 4096;
const SALT_SIZE = 16;
const KEY_SIZE = 32;
// SQLCipher keeps 80 bytes per page for the IV and the page HMAC.
const RESERVE = 80;
const HMAC_SIZE = 64;
const KDF_ITERATIONS = 256_000;
const MAC_KDF_ITERATIONS = 2;
const MAC_SALT_XOR = 0x3a;

const pbkdf2Async = promisify(pbkdf2);

/** One database's key, as `wechat-bridge` stores it. */
interface StoredKey {
  encKey: string;
  salt: string;
  sizeMb: number;
}

/** `wechat-bridge`'s keys file. Its reads open `dbDir` with these keys and
 *  refuse them when the signed-in account is not `wxid`. */
interface StoredKeys {
  dbDir: string;
  wxid: string;
  keys: Record<string, StoredKey>;
  capturedAt: string;
}

/**
 * Why the store's keys are not usable. `rejected` needs a fresh capture: no
 * account, a passphrase that opens nothing, or stored keys that stopped
 * fitting. `pending` means the client is still creating a required database,
 * which a later derive with the same passphrase can open.
 */
export class WechatStoreKeysError extends Error {
  constructor(
    readonly kind: "rejected" | "pending",
    message: string,
  ) {
    super(message);
    this.name = "WechatStoreKeysError";
  }
}

export interface WechatStoreKeysPaths {
  /** The account directory, `<home>/xwechat_files/<wxid>`, or null when no
   *  account store exists. */
  accountDir: string | null;
  /** The bridge's keys file. */
  keysFile: string;
}

interface Database {
  rel: string;
  size: number;
  salt: string;
  page1: Buffer;
}

/**
 * Does this key open this database? SQLCipher authenticates each page with an
 * HMAC keyed from the page key, so page 1 verifying proves the key, without a
 * decrypt.
 */
function verifyKey(encKey: Buffer, page1: Buffer): boolean {
  if (encKey.length !== KEY_SIZE || page1.length !== PAGE_SIZE) return false;
  const salt = page1.subarray(0, SALT_SIZE);
  const macSalt = Buffer.from(salt.map((b) => b ^ MAC_SALT_XOR));
  const macKey = pbkdf2Sync(encKey, macSalt, MAC_KDF_ITERATIONS, KEY_SIZE, "sha512");
  const pageNo = Buffer.alloc(4);
  pageNo.writeUInt32LE(1, 0);
  const mac = createHmac("sha512", macKey)
    .update(page1.subarray(SALT_SIZE, PAGE_SIZE - RESERVE + SALT_SIZE))
    .update(pageNo)
    .digest();
  return timingSafeEqual(mac, page1.subarray(PAGE_SIZE - HMAC_SIZE, PAGE_SIZE));
}

/** The first page of a database, or null when it is not a full page yet. */
async function firstPage(path: string): Promise<{ page1: Buffer; size: number } | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const page1 = Buffer.alloc(PAGE_SIZE);
    const { bytesRead } = await handle.read(page1, 0, PAGE_SIZE, 0);
    if (bytesRead < PAGE_SIZE) return null;
    return { page1, size: (await handle.stat()).size };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Every database under the store, with the salt each is keyed by. Paths are
 *  relative to the store and use `/`, as the bridge looks them up. */
async function collectDatabases(dbDir: string): Promise<Database[]> {
  const found: Database[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".db")) {
        const page = await firstPage(path);
        if (!page) continue;
        found.push({
          rel: relative(dbDir, path).split(sep).join("/"),
          size: page.size,
          salt: page.page1.subarray(0, SALT_SIZE).toString("hex"),
          page1: page.page1,
        });
      }
    }
  };
  await walk(dbDir);
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * The databases the reader cannot do without: the session list, the contact
 * list it names chats from, and every message shard. A store with no shard yet
 * is still being created.
 */
async function requiredDatabases(dbDir: string): Promise<string[]> {
  const shards = (await readdir(join(dbDir, "message")).catch(() => [] as string[]))
    .filter((name) => /^message_\d+\.db$/.test(name))
    .sort()
    .map((name) => `message/${name}`);
  if (shards.length === 0) {
    throw new WechatStoreKeysError(
      "pending",
      "The WeChat message databases are not available yet.",
    );
  }
  return ["session/session.db", "contact/contact.db", ...shards];
}

/**
 * Authenticate every required database before history is exposed. `invalid`
 * is the kind a database no key opens reports: stored keys that stop fitting
 * are a locked store, while a fresh derive waits for the client.
 */
async function validateKeys(
  dbDir: string,
  keys: Record<string, StoredKey>,
  invalid: WechatStoreKeysError["kind"],
): Promise<void> {
  for (const rel of await requiredDatabases(dbDir)) {
    const page = await firstPage(join(dbDir, rel));
    if (!page) {
      throw new WechatStoreKeysError("pending", `The WeChat client is still creating ${rel}.`);
    }
    const key = Buffer.from(keys[rel]?.encKey ?? "", "hex");
    if (!verifyKey(key, page.page1)) {
      throw new WechatStoreKeysError(
        invalid,
        `The WeChat message store is locked: ${rel} has no valid key.`,
      );
    }
  }
}

function storeDir(accountDir: string | null): string {
  if (!accountDir) {
    throw new WechatStoreKeysError(
      "rejected",
      "The WeChat account is signed out on this instance.",
    );
  }
  return join(accountDir, "db_storage");
}

/** Write `value` as JSON readable only by the runtime user, replacing the file
 *  in one step so a reader never sees half of it. */
async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const owner = await lstat(dir);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.()) {
    throw new WechatStoreKeysError(
      "rejected",
      "The keys directory must be owned by the runtime user.",
    );
  }
  await chmod(dir, 0o700);
  const temporary = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Turn the captured passphrase into per-database keys, verify every required
 * database, and write them where the bridge reads. Databases sharing a salt
 * share a key, so each salt is derived once: PBKDF2 at 256000 iterations is
 * not free and a large account has dozens of shards.
 */
export async function deriveStoreKeys(
  passphraseHex: string,
  paths: WechatStoreKeysPaths,
  signal?: AbortSignal,
): Promise<{ derived: number; databases: number; wxid: string }> {
  const dbDir = storeDir(paths.accountDir);
  if (!/^[0-9a-fA-F]{64}$/.test(passphraseHex.trim())) {
    throw new WechatStoreKeysError("rejected", "The recovered passphrase is not 32 bytes of hex.");
  }
  const passphrase = Buffer.from(passphraseHex.trim(), "hex");
  const databases = await collectDatabases(dbDir);
  if (databases.length === 0) {
    throw new WechatStoreKeysError(
      "pending",
      "The signed-in account has no message databases yet.",
    );
  }

  const bySalt = new Map<string, Database[]>();
  for (const db of databases) bySalt.set(db.salt, [...(bySalt.get(db.salt) ?? []), db]);
  const keys: Record<string, StoredKey> = {};
  for (const [salt, group] of bySalt) {
    signal?.throwIfAborted();
    // 256000 rounds per salt: off the event loop, so serving continues meanwhile.
    const encKey = await pbkdf2Async(
      passphrase,
      Buffer.from(salt, "hex"),
      KDF_ITERATIONS,
      KEY_SIZE,
      "sha512",
    );
    for (const db of group) {
      if (!verifyKey(encKey, db.page1)) continue;
      keys[db.rel] = {
        encKey: encKey.toString("hex"),
        salt,
        sizeMb: Math.round((db.size / 1048576) * 10) / 10,
      };
    }
  }
  if (Object.keys(keys).length === 0) {
    throw new WechatStoreKeysError(
      "rejected",
      "The recovered passphrase does not open this account's databases.",
    );
  }

  // The passphrase opened at least one database, so it is the account's. A
  // required database it does not open yet is one the client created but has
  // not finished writing: its first page is still being laid down.
  await validateKeys(dbDir, keys, "pending");

  const wxid = basename(paths.accountDir!);
  const stored: StoredKeys = { dbDir, wxid, keys, capturedAt: new Date().toISOString() };
  // A cancelled setup writes nothing durable.
  signal?.throwIfAborted();
  await writePrivateJson(paths.keysFile, stored);
  return { derived: Object.keys(keys).length, databases: databases.length, wxid };
}

async function readStoredKeys(keysFile: string): Promise<StoredKeys | null> {
  try {
    const parsed = JSON.parse(await readFile(keysFile, "utf8")) as Partial<StoredKeys>;
    if (!parsed || typeof parsed !== "object" || !parsed.keys || typeof parsed.keys !== "object") {
      return null;
    }
    return parsed as StoredKeys;
  } catch {
    return null;
  }
}

/** Resolve when the stored keys belong to the signed-in account and open every
 *  required database. Otherwise throws {@link WechatStoreKeysError}. */
export async function checkStoreKeys(paths: WechatStoreKeysPaths): Promise<void> {
  const dbDir = storeDir(paths.accountDir);
  const stored = await readStoredKeys(paths.keysFile);
  if (!stored) {
    throw new WechatStoreKeysError(
      "rejected",
      "The WeChat message store has not been unlocked yet.",
    );
  }
  if (stored.dbDir !== dbDir) {
    throw new WechatStoreKeysError(
      "rejected",
      "The WeChat reader keys do not belong to this account.",
    );
  }
  await validateKeys(dbDir, stored.keys, "rejected");
}

/**
 * Carry keys the earlier Python reader stored (`~/.wechat-cli/all_keys.json`
 * beside a `config.json` naming the store) into the bridge's file, so an
 * account unlocked before the bridge reads without another capture. Does
 * nothing when the bridge's file exists or the old keys do not fit this
 * account. Never throws: an unmigrated account just captures again.
 */
export async function migrateLegacyStoreKeys(
  legacyDir: string,
  paths: WechatStoreKeysPaths,
): Promise<boolean> {
  try {
    if (!paths.accountDir || (await readStoredKeys(paths.keysFile))) return false;
    const dbDir = storeDir(paths.accountDir);
    const config = JSON.parse(await readFile(join(legacyDir, "config.json"), "utf8")) as {
      db_dir?: unknown;
    };
    if (config.db_dir !== dbDir) return false;
    const legacy = JSON.parse(await readFile(join(legacyDir, "all_keys.json"), "utf8")) as Record<
      string,
      { enc_key?: unknown; salt?: unknown; size_mb?: unknown }
    >;
    const keys: Record<string, StoredKey> = {};
    for (const [rel, entry] of Object.entries(legacy)) {
      if (typeof entry?.enc_key !== "string" || typeof entry.salt !== "string") continue;
      keys[rel.split(sep).join("/")] = {
        encKey: entry.enc_key,
        salt: entry.salt,
        sizeMb: typeof entry.size_mb === "number" ? entry.size_mb : 0,
      };
    }
    await validateKeys(dbDir, keys, "rejected");
    await writePrivateJson(paths.keysFile, {
      dbDir,
      wxid: basename(paths.accountDir),
      keys,
      capturedAt: new Date().toISOString(),
    } satisfies StoredKeys);
    return true;
  } catch {
    return false;
  }
}
