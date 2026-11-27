import type { Identity } from "./identity.js";

/** What {@link botsOfPersons} reads and changes of a message. */
export interface HeardFrom {
  senderId: string;
  fromBot?: boolean;
}

/**
 * Reads a message from a bot account that belongs to a person as that
 * person's. A bot account given to someone, such as a Discord webhook that
 * posts for them, speaks for that person, so `fromBot` comes off.
 */
export function botsOfPersons(
  identity: Pick<Identity, "personOf">,
): (platform: string, message: HeardFrom) => Promise<void> {
  return async (platform, message) => {
    if (!message.fromBot) return;
    if (await identity.personOf({ platform, accountId: message.senderId })) delete message.fromBot;
  };
}
