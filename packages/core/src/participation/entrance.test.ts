import { describe, expect, it } from "@rstest/core";
import { enteredAs, entrance, markEntered } from "./entrance.js";
import type { EntryAccount } from "./entry.js";

/** An entrance that lets Ada in, and how often it asked. */
function onlyAda() {
  const asked: EntryAccount[] = [];
  return {
    asked,
    entrance: entrance<string>({
      enter: async (account) => {
        asked.push(account);
        return account.id === "ada" ? { kind: "entered", person: "Ada" } : { kind: "unknown" };
      },
    }),
  };
}

describe("entrance", () => {
  it("names whom a message is let in as, asking once", async () => {
    const { asked, entrance: door } = onlyAda();
    expect(await door.message({ platform: "slack", id: "ada" })).toBe("Ada");
    expect(await door.message({ platform: "slack", id: "sam" })).toBeUndefined();
    expect(asked).toEqual([
      { platform: "slack", id: "ada" },
      { platform: "slack", id: "sam" },
    ]);
  });

  it("runs a command for someone let in alone, and keeps the list", async () => {
    const { asked, entrance: door } = onlyAda();
    const ran: string[] = [];
    const commands = door.commands("discord", {
      list: ["stop"],
      ran: async (command: { sender: { accountId: string } }) => {
        ran.push(command.sender.accountId);
        return "Stopped.";
      },
      suggest: async (
        _command: { sender: { accountId: string } },
        _option: string,
        _typed: string,
      ) => ["main"],
    });
    const by = (accountId: string) => ({ sender: { accountId } });
    expect(commands.list).toEqual(["stop"]);
    expect(await commands.ran(by("ada"))).toBe("Stopped.");
    expect(await commands.ran(by("sam"))).toBe(
      "Only the guardian and members of this Rome can run its commands.",
    );
    expect(ran).toEqual(["ada"]);
    expect(await commands.suggest(by("ada"), "name", "")).toEqual(["main"]);
    expect(await commands.suggest(by("sam"), "name", "")).toEqual([]);
    expect(asked[0]).toEqual({ platform: "discord", id: "ada" });
    expect(asked).toHaveLength(4);
  });

  it("answers a press by someone let in alone", async () => {
    const { entrance: door } = onlyAda();
    const answered: string[] = [];
    for (const id of ["sam", "ada"]) {
      await door.press({ platform: "feishu", id }, async () => {
        answered.push(id);
      });
    }
    expect(answered).toEqual(["ada"]);
  });
});

describe("markEntered", () => {
  it("stays on a copy of the event, and is nothing an event can carry itself", () => {
    const event = { text: "hi" };
    expect(enteredAs({ ...markEntered(event, "Ada") })).toBe("Ada");
    expect(enteredAs(markEntered(event, undefined))).toBeUndefined();
    expect(enteredAs(JSON.parse(JSON.stringify(markEntered(event, "Ada"))))).toBeUndefined();
    expect(enteredAs({ ...event, entered: "Ada" })).toBeUndefined();
  });
});
