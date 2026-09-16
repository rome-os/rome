import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "@rstest/core";

const helper = fileURLToPath(new URL("./wechat-user-helper.py", import.meta.url));
const passphrase = "ab".repeat(32);
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function store(messagePassphrase = passphrase) {
  const home = await mkdtemp(join(tmpdir(), "wechat-keys-"));
  homes.push(home);
  const dbDir = join(home, "xwechat_files/wxid_test/db_storage");
  for (const [rel, secret] of [
    ["session/session.db", passphrase],
    ["message/message_0.db", messagePassphrase],
  ]) {
    const page = Buffer.alloc(4096, rel!.startsWith("session/") ? 7 : 9);
    const salt = page.subarray(0, 16);
    const key = pbkdf2Sync(Buffer.from(secret!, "hex"), salt, 256000, 32, "sha512");
    const macSalt = Buffer.from(salt.map((byte) => byte ^ 0x3a));
    const macKey = pbkdf2Sync(key, macSalt, 2, 32, "sha512");
    const pageNumber = Buffer.alloc(4);
    pageNumber.writeUInt32LE(1);
    createHmac("sha512", macKey)
      .update(page.subarray(16, 4032))
      .update(pageNumber)
      .digest()
      .copy(page, 4032);
    const path = join(dbDir, rel!);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, page);
  }
  return { home, dbDir };
}

function run(home: string, args: string[]) {
  return spawnSync("python3", [helper, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

describe("WeChat key readiness", () => {
  it("reports a pending store while login has not created the message shard", async () => {
    const { home, dbDir } = await store();
    await rm(join(dbDir, "message/message_0.db"));
    const result = run(home, ["derive", "--passphrase", passphrase]);
    expect(result.status, result.stderr).toBe(4);
  });

  it("rejects a recovered passphrase that cannot open the message shard", async () => {
    const { home } = await store("cd".repeat(32));
    const result = run(home, ["derive", "--passphrase", passphrase]);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain("message/message_0.db");
  });

  it("verifies persisted keys against every required database", async () => {
    const { home, dbDir } = await store();
    const derived = run(home, ["derive", "--passphrase", passphrase]);
    expect(derived.status, derived.stderr).toBe(0);
    for (const name of ["all_keys.json", "config.json"]) {
      expect((await stat(join(home, ".wechat-cli", name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(home, ".wechat-cli"))).mode & 0o777).toBe(0o700);
    const checked = run(home, ["check"]);
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ keysReady: true });

    const keysFile = join(home, ".wechat-cli/all_keys.json");
    const keys = JSON.parse(await readFile(keysFile, "utf8"));
    delete keys["message/message_0.db"];
    await writeFile(keysFile, JSON.stringify(keys));
    expect(run(home, ["check"]).status).toBe(3);
    expect(run(home, ["messages", "--conversation", "wxid_friend"]).status).toBe(3);

    execFileSync("python3", [helper, "derive", "--passphrase", passphrase], {
      env: { ...process.env, HOME: home },
    });
    await writeFile(join(dbDir, "message/message_0.db"), Buffer.alloc(4096));
    expect(run(home, ["check"]).status).toBe(3);
  });
});

it("preserves SQLite page boundaries, unreadable rows, and capture cleanup", () => {
  execFileSync("python3", [
    fileURLToPath(new URL("./wechat-user-helper-fixtures.py", import.meta.url)),
  ]);
});
