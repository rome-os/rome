// The WeChat reader against a real, encrypted account store, read by the
// pinned wechat-bridge itself. The other reader tests answer for the bridge;
// these pin what the bridge actually does with the client's file formats.
//
// The fixture is a synthetic store laid out as the client writes it: plain
// SQLite pages with SQLCipher's 80 reserved bytes, encrypted with AES-256-CBC
// and authenticated with HMAC-SHA512, and a bridge keys file that fits it.

import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { WechatUserReader, WechatUserRuntime } from "./wechat-user.js";

const PAGE = 4096;
const RESERVE = 80;
const WXID = "wxid_guardian";

let home: string;
let dbDir: string;
const encKey = randomBytes(32);
const salt = randomBytes(16);

/** Plain SQLite with SQLCipher's page layout. SQLite keeps the reserved bytes
 *  its header names, so the header and the empty schema page are set before
 *  any table is written. */
async function plainDatabase(build: (db: DatabaseSync) => void): Promise<Buffer> {
  const path = join(home, `plain-${randomBytes(4).toString("hex")}.db`);
  let db = new DatabaseSync(path);
  db.exec("PRAGMA page_size = 4096; PRAGMA journal_mode = DELETE; PRAGMA user_version = 1;");
  db.close();
  const handle = await open(path, "r+");
  await handle.write(Buffer.from([RESERVE]), 0, 1, 20);
  const contentStart = Buffer.alloc(2);
  contentStart.writeUInt16BE(PAGE - RESERVE, 0);
  await handle.write(contentStart, 0, 2, 105);
  await handle.close();
  db = new DatabaseSync(path);
  build(db);
  db.close();
  const image = await readFile(path);
  await rm(path);
  return image;
}

/** SQLCipher 4 as WCDB writes it: page 1 starts with the salt, and every page
 *  ends with its IV and HMAC. */
function encrypt(image: Buffer): Buffer {
  const macKey = pbkdf2Sync(encKey, Buffer.from(salt.map((b) => b ^ 0x3a)), 2, 32, "sha512");
  const out = Buffer.alloc(image.length);
  for (let i = 0; i < image.length / PAGE; i++) {
    const page = out.subarray(i * PAGE, (i + 1) * PAGE);
    const start = i === 0 ? salt.length : 0;
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", encKey, iv).setAutoPadding(false);
    const plain = image.subarray(i * PAGE + start, (i + 1) * PAGE - RESERVE);
    if (i === 0) salt.copy(page, 0);
    Buffer.concat([cipher.update(plain), cipher.final()]).copy(page, start);
    iv.copy(page, PAGE - RESERVE);
    const pageNo = Buffer.alloc(4);
    pageNo.writeUInt32LE(i + 1, 0);
    createHmac("sha512", macKey)
      .update(page.subarray(start, PAGE - RESERVE + iv.length))
      .update(pageNo)
      .digest()
      .copy(page, PAGE - 64);
  }
  return out;
}

async function store(rel: string, build: (db: DatabaseSync) => void): Promise<void> {
  const path = join(dbDir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encrypt(await plainDatabase(build)));
}

const messageTable = (wxid: string) => `Msg_${createHash("md5").update(wxid).digest("hex")}`;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wechat-store-"));
  dbDir = join(home, "xwechat_files", WXID, "db_storage");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A reader over the fixture store, with keys as `init` writes them. */
async function reader(): Promise<WechatUserReader> {
  const runtime = new WechatUserRuntime({
    home,
    desktop: null,
    canonicalPrefix: join(home, "opt"),
    runtimeDir: join(home, "run"),
  });
  const keys = Object.fromEntries(
    ["session/session.db", "contact/contact.db", "message/message_0.db"].map((rel) => [
      rel,
      { encKey: encKey.toString("hex"), salt: salt.toString("hex"), sizeMb: 0 },
    ]),
  );
  await mkdir(dirname(runtime.keysFile), { recursive: true });
  await writeFile(
    runtime.keysFile,
    JSON.stringify({ dbDir, wxid: WXID, keys, capturedAt: "2026-10-07T00:00:00Z" }),
  );
  return new WechatUserReader(runtime);
}

describe("WechatUserReader over a real store", () => {
  beforeEach(async () => {
    await store("session/session.db", (db) =>
      db.exec(`CREATE TABLE SessionTable(username TEXT PRIMARY KEY, type INTEGER,
          unread_count INTEGER, is_hidden INTEGER, summary TEXT, status INTEGER,
          last_timestamp INTEGER, sort_timestamp INTEGER, last_msg_type INTEGER,
          last_msg_sub_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT);
        INSERT INTO SessionTable VALUES
          ('wxid_friend', 0, 0, 0, 'after', 0, 30, 30, 1, 0, NULL, NULL),
          ('wxid_hidden', 0, 0, 1, 'psst', 0, 20, 20, 1, 0, NULL, NULL)`),
    );
    await store("contact/contact.db", (db) =>
      db.exec(`CREATE TABLE contact(id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER,
          verify_flag INTEGER, remark TEXT, nick_name TEXT);
        INSERT INTO contact(username, local_type, verify_flag, remark, nick_name)
          VALUES ('wxid_friend', 1, 0, '', 'A Friend'), ('wxid_hidden', 1, 0, '', 'Hidden')`),
    );
    await store("message/message_0.db", (db) => {
      db.exec(`CREATE TABLE Name2Id(user_name TEXT);
        INSERT INTO Name2Id VALUES ('wxid_friend'), ('wxid_hidden')`);
      for (const wxid of ["wxid_friend", "wxid_hidden"]) {
        db.exec(`CREATE TABLE "${messageTable(wxid)}"(local_id INTEGER PRIMARY KEY,
          local_type INTEGER, create_time INTEGER, real_sender_id INTEGER,
          message_content BLOB, WCDB_CT_message_content INTEGER)`);
      }
      const friend = db.prepare(
        `INSERT INTO "${messageTable("wxid_friend")}" VALUES (?,?,?,?,?,?)`,
      );
      friend.run(1, 1, 10, 1, "before", 0);
      // Flagged as zstd, but not a zstd frame: the body cannot be decoded.
      friend.run(2, 1, 20, 1, Buffer.from("not zstd"), 4);
      friend.run(3, 1, 30, 1, "after", 0);
      db.prepare(`INSERT INTO "${messageTable("wxid_hidden")}" VALUES (?,?,?,?,?,?)`).run(
        1,
        1,
        20,
        2,
        "psst",
        0,
      );
    });
  });

  it("keeps an unreadable message between readable ones", async () => {
    const messages = await (await reader()).messages({ conversationId: "wxid_friend", limit: 10 });
    expect(messages.map((m) => m.text)).toEqual(["before", "[Unreadable message]", "after"]);
  }, 60_000);

  it("counts a chat without reading its bodies", async () => {
    const r = await reader();
    expect(await r.count("wxid_friend")).toBe(3);
    expect(await r.count("wxid_nobody")).toBe(0);
  }, 60_000);

  it("lists chats hidden in the client", async () => {
    const conversations = await (await reader()).conversations({ limit: 10 });
    expect(conversations.map((c) => [c.id, c.name])).toEqual([
      ["wxid_friend", "A Friend"],
      ["wxid_hidden", "Hidden"],
    ]);
  }, 60_000);
});
