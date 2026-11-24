import type { ChannelMessage } from "@rome-os/app-runtime";
import type { PeopleRepository } from "./model/people-repository.js";

/**
 * Reads a message from a bot account linked to a person as that person's.
 * A bot account the guardian linked to someone, such as a Discord webhook
 * that posts for them, speaks for that person, so `fromBot` comes off.
 */
export function botsOfPeople(
  repo: Pick<PeopleRepository, "byAccount">,
): (platform: string, message: ChannelMessage) => Promise<void> {
  return async (platform, message) => {
    if (!message.fromBot) return;
    if (await repo.byAccount({ platform, id: message.senderId })) delete message.fromBot;
  };
}
