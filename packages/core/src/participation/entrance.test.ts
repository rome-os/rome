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
