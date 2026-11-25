import { describe, expect, it } from "@rstest/core";
import { arrivalOf, entrance, markArrival } from "./entrance.js";
import type { Entry, EntryAccount } from "./entry.js";

describe("entrance", () => {
  it("answers for a message's sender, asking once", async () => {
    const asked: EntryAccount[] = [];
    const door = entrance<string>({
      enter: async (account) => {
        asked.push(account);
        return account.id === "ada" ? { kind: "entered", person: "Ada" } : { kind: "unknown" };
      },
    });
    const ada = { platform: "slack", id: "ada" };
    const sam = { platform: "slack", id: "sam" };
    expect(await door.message(ada)).toEqual({ kind: "entered", person: "Ada" });
    expect(await door.message(sam)).toEqual({ kind: "unknown" });
    expect(asked).toEqual([ada, sam]);
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
