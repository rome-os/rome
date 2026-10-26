import type { ChannelSummary, ChannelsService } from "@rome-os/app-runtime";

/**
 * The account a tool's `channel` names: one of Rome's channels by its name,
 * or else Rome's account on the platform it names, such as `email` or
 * `whatsapp`. The name of a channel Rome holds wins, since it is the address a
 * message arrived on. A platform counts only the accounts Rome holds now, and
 * a channel left behind by a disconnected account is read by its name only
 * where no held account is on a platform of that name. Answers
 * undefined when nothing matches, and throws when Rome holds several accounts
 * on the platform, since picking one would send as the wrong one.
 */
export async function romeAccountNamed(
  channels: ChannelsService,
  channel: string,
): Promise<ChannelSummary | undefined> {
  const summaries = await channels.list();
  const named = summaries.find((summary) => summary.name === channel);
  if (named?.sendable) return named;
  const held = summaries.filter((summary) => summary.sendable && summary.platform === channel);
  if (held.length > 1) {
    const names = held.map((summary) => `"${summary.name}"`).join(", ");
    throw new Error(
      `Rome has several accounts on "${channel}": ${names}. Name the one to use as \`channel\`.`,
    );
  }
  return held[0] ?? named;
}

/** What `send` and `query` take for an account: its platform and id where
 *  the host names them, or else its channel's name. */
export function addressOf(summary: ChannelSummary) {
  return summary.account ?? summary.name;
}
