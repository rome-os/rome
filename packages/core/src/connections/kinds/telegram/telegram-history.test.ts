import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@rstest/core";
import { TelegramHistory, type TelegramHistoryMessage } from "./telegram-history.js";

// What these pin: a bot's history survives a restart, reads newest first and
// pages back, keeps a message once, and a revised reply reads as revised.

function said(id: string, text = `text ${id}`): TelegramHistoryMessage {
  return { id, from: "Alice", fromId: "1", at: new Date(0).toISOString(), text };
}

describe("TelegramHistory", () => {
  const dirs: string[] = [];
  const dir = () => {
    const made = mkdtempSync(join(tmpdir(), "tg-history-"));
    dirs.push(made);
    return made;
  };
  afterEach(() => {
    for (const each of dirs.splice(0)) rmSync(each, { recursive: true, force: true });
  });

  it("reads what it kept newest first, and pages back", () => {
    const history = new TelegramHistory(dir());
    for (const id of ["1", "2", "3"]) history.keep("-100", said(id));
    expect(history.read("-100", { limit: 2 }).map((m) => m.id)).toEqual(["3", "2"]);
    expect(history.read("-100", { limit: 2, before: "2" }).map((m) => m.id)).toEqual(["1"]);
  });

  it("survives a restart, with each message once and its last text", () => {
    const at = dir();
    const before = new TelegramHistory(at);
    before.keep("-100", said("1"));
    before.keep("-100", said("1"));
    before.keep("-100", said("2", "draft"));
    before.revise("-100", "2", "final");
    const after = new TelegramHistory(at);
    expect(after.read("-100", { limit: 10 }).map((m) => [m.id, m.text])).toEqual([
      ["2", "final"],
      ["1", "text 1"],
    ]);
  });
});
