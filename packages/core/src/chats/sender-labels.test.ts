import { describe, expect, it } from "@rstest/core";
import type { Account } from "@rome-os/app-runtime";
import type { Person } from "../db/repositories/people.js";
import type { ContextLine, UnseenLine } from "../sessions/turn-links.js";
import { SenderLabels, senderLabel } from "./sender-labels.js";

const at = new Date("2026-11-14T03:00:00.000Z");
const ana: Account = { platform: "discord", id: "ana" };
const bot: Account = { platform: "discord", id: "ana-bot" };

const ANA: Person = {
  id: "p-ana",
  displayName: "Ana Lopez",
  bondLevel: "inner-circle",
  profilePath: null,
  createdAt: at,
  links: [ana, { ...bot, delegate: true }],
};

function line(id: number, senderName: string | null, account: Account | null): ContextLine {
  return { id, senderName, account, text: `m${id}`, at };
}

describe("senderLabel", () => {
  it("names the person and bond level behind a linked account", () => {
    expect(senderLabel(line(1, "Ana", ana), ANA)).toBe("Ana (Ana Lopez, inner circle)");
  });

  it("says an account linked to nobody is not linked, whatever name it shows", () => {
    expect(senderLabel(line(1, "Ana Lopez", { platform: "discord", id: "x" }), null)).toBe(
      "Ana Lopez (not linked)",
    );
  });

  it("says an agent's account acts for the person who delegated it", () => {
    expect(senderLabel(line(1, "Ana's bot", bot), ANA)).toBe(
      "Ana's bot (agent acting for Ana Lopez, inner circle)",
    );
  });

  it("falls back to the person's name when the message showed none", () => {
    expect(senderLabel(line(1, null, ana), ANA)).toBe("Ana Lopez (Ana Lopez, inner circle)");
  });

  it("keeps the name of a message with no account, as Rome's own", () => {
    expect(senderLabel(line(1, "Rome", null), null)).toBe("Rome");
  });
});

describe("SenderLabels", () => {
  it("asks People once per account and labels every message it reads", async () => {
    const asked: Account[] = [];
    const labels = new SenderLabels({
      byAccount: async (account) => {
        asked.push(account);
        return account.id === "ana" ? ANA : null;
      },
    });
    const quoted = line(1, "Ana", ana);
    const unseen: UnseenLine[] = [
      { ...line(2, "Ana", ana), fromRome: false, quoted: null, quotesOutside: false },
      {
        ...line(3, "Bob", { platform: "discord", id: "bob" }),
        fromRome: false,
        quoted,
        quotesOutside: false,
      },
    ];

    expect(await labels.readUnseen(unseen)).toEqual([
      {
        id: 2,
        sender: "Ana (Ana Lopez, inner circle)",
        text: "m2",
        at,
        fromRome: false,
        quoted: null,
        quotesOutside: false,
      },
      {
        id: 3,
        sender: "Bob (not linked)",
        text: "m3",
        at,
        fromRome: false,
        quoted: { id: 1, sender: "Ana (Ana Lopez, inner circle)", text: "m1", at },
        quotesOutside: false,
      },
    ]);
    expect(asked.map((account) => account.id).sort()).toEqual(["ana", "bob"]);
  });
});
