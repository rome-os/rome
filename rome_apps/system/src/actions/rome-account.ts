import type { ChannelSummary, ChannelsService } from "@rome-os/app-runtime";

/**
 * The account a tool's `channel` names: one of Rome's channels by its name,
 * or else Rome's account on the platform it names, such as `email` or
 * `whatsapp`. Only `among` counts, so a send passes the accounts it can send
 * as. Answers undefined when nothing matches, and throws when the platform has
 * several of Rome's accounts, since picking one would send as the wrong one.
 */
export async function romeAccountNamed(
  channels: ChannelsService,
  channel: string,
  among: (summary: ChannelSummary) => boolean = () => true,
): Promise<ChannelSummary | undefined> {
  const summaries = (await channels.list()).filter(among);
  const named = summaries.find((summary) => summary.name === channel);
  if (named) return named;
  const onPlatform = summaries.filter((summary) => summary.platform === channel);
  if (onPlatform.length > 1) {
    const names = onPlatform.map((summary) => `"${summary.name}"`).join(", ");
    throw new Error(
      `Rome has several accounts on "${channel}": ${names}. Name the one to use as \`channel\`.`,
    );
  }
  return onPlatform[0];
}

/** What `send` and `query` take for an account: its platform and id where
 *  the host names them, or else its channel's name. */
export function addressOf(summary: ChannelSummary) {
  return summary.account ?? summary.name;
}
