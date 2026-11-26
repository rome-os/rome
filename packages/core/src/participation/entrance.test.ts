import { describe, expect, it } from "@rstest/core";
import { arrivalOf, enteredAs, entrance, markArrival } from "./entrance.js";
import type { Entry, EntryAccount } from "./entry.js";

/** An entrance that lets Ada in, and whom it was asked about. */
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
  it("answers for a message's sender, asking once", async () => {
    const { asked, entrance: door } = onlyAda();
    const ada = { platform: "slack", id: "ada" };
    const sam = { platform: "slack", id: "sam" };
    expect(await door.message(ada)).toEqual({ kind: "entered", person: "Ada" });
    expect(await door.message(sam)).toEqual({ kind: "unknown" });
    expect(asked).toEqual([ada, sam]);
  });

  it("runs a command for someone let in alone, and keeps the list", async () => {
    const { asked, entrance: door } = onlyAda();
    const ran: string[] = [];
    const commands = door.commands("discord", {
      list: ["stop"],
      ran: async (command: { sender: { accountId: string } }, by: string) => {
        ran.push(`${command.sender.accountId} as ${by}`);
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
    expect(ran).toEqual(["ada as Ada"]);
    expect(await commands.suggest(by("ada"), "name", "")).toEqual(["main"]);
    expect(await commands.suggest(by("sam"), "name", "")).toEqual([]);
    expect(asked[0]).toEqual({ platform: "discord", id: "ada" });
    expect(asked).toHaveLength(4);
  });

  it("answers a press by someone let in alone, told whom as", async () => {
    const { entrance: door } = onlyAda();
    const answered: string[] = [];
    for (const id of ["sam", "ada"]) {
      await door.press({ platform: "feishu", id }, async (by) => {
        answered.push(`${id} as ${by}`);
      });
    }
    expect(answered).toEqual(["ada as Ada"]);
  });
});

describe("markArrival", () => {
  it("stays on a copy of the event, and is nothing an event can carry itself", () => {
    const entry: Entry = { kind: "entered", person: "Ada" };
    const arrival = { entry, automated: false };
    const marked = markArrival({ text: "hi" }, arrival);
    expect(arrivalOf({ ...marked })).toEqual(arrival);
    expect(arrivalOf(JSON.parse(JSON.stringify(marked)))).toBeUndefined();
    expect(arrivalOf({ text: "hi", arrival })).toBeUndefined();
  });
});

describe("enteredAs", () => {
  it("names only someone let in", () => {
    const event = (entry: Entry) => markArrival({ text: "hi" }, { entry, automated: false });
    expect(enteredAs(event({ kind: "entered", person: "Ada" }))).toBe("Ada");
    expect(enteredAs(event({ kind: "unknown" }))).toBeUndefined();
    expect(enteredAs(event({ kind: "refused" }))).toBeUndefined();
    expect(enteredAs({ text: "hi" })).toBeUndefined();
  });
});
