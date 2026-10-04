// A stand-in for WeChat's encrypted message store, for tests. Each database is
// one SQLCipher first page: a salt, filler, and the page HMAC a key verifies
// against. Nothing here decrypts; it only needs keys to verify or not.

import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PAGE_SIZE = 4096;
const SALT_SIZE = 16;

/** The databases a readable store needs, plus one the reader does not. */
export const STORE_DATABASES = [
  "session/session.db",
  "contact/contact.db",
  "message/message_0.db",
  "favorite/favorite.db",
];

/** The page key a passphrase gives for a salt, as the client derives it. */
export function pageKey(passphrase: Buffer, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, 256_000, 32, "sha512");
}

/** A first page keyed by `encKey`, carrying `salt`. */
function firstPage(encKey: Buffer, salt: Buffer): Buffer {
  const page = randomBytes(PAGE_SIZE);
  salt.copy(page, 0);
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a));
  const macKey = pbkdf2Sync(encKey, macSalt, 2, 32, "sha512");
  const pageNo = Buffer.alloc(4);
  pageNo.writeUInt32LE(1, 0);
  createHmac("sha512", macKey)
    .update(page.subarray(SALT_SIZE, PAGE_SIZE - 80 + SALT_SIZE))
    .update(pageNo)
    .digest()
    .copy(page, PAGE_SIZE - 64);
  return page;
}

/**
 * Write a store under `dbDir` whose databases all share `salt` and open with
 * `encKey`. Answers the keys file the bridge would read for it.
 */
export async function writeStore(
  dbDir: string,
  encKey: Buffer,
  salt: Buffer,
  databases: readonly string[] = STORE_DATABASES,
): Promise<Record<string, { encKey: string; salt: string; sizeMb: number }>> {
  const keys: Record<string, { encKey: string; salt: string; sizeMb: number }> = {};
  for (const rel of databases) {
    const path = join(dbDir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, firstPage(encKey, salt));
    keys[rel] = { encKey: encKey.toString("hex"), salt: salt.toString("hex"), sizeMb: 0 };
  }
  return keys;
}
