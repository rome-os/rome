import type { ChannelMessage } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import { botsOfPeople } from "./bots-of-people.js";
import type { Person } from "./model/person.js";

const linked = botsOfPeople({
  byAccount: async ({ id }) => (id === "member-webhook" ? ({ id: "person-1" } as Person) : null),
});

function fromBot(senderId: string): ChannelMessage {
  return { senderId, fromBot: true } as ChannelMessage;
}

describe("botsOfPeople", () => {
  it("reads a bot account linked to a person as that person", async () => {
    const message = fromBot("member-webhook");
    await linked("discord", message);
    expect(message).not.toHaveProperty("fromBot");
  });

  it("leaves a bot account linked to nobody a bot", async () => {
    const message = fromBot("ci-webhook");
    await linked("discord", message);
    expect(message.fromBot).toBe(true);
  });
});
