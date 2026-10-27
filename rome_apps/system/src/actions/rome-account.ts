import type { ChannelSummary, ChannelsService } from "@rome-os/app-runtime";

/** How a tool names the account to use: a channel by its name, which is the
 *  address a message arrived on, or a platform, which means Rome's account
 *  there. The two are separate inputs, so a channel named after its platform
 *  never stands for the platform. */
export interface AccountSelector {
  channel?: string;
  platform?: string;
}

/**
 * The account `selector` names. A channel is matched by its name alone. A
 * platform counts only the accounts Rome holds now, so a channel left behind by
 * a disconnected account never makes it ambiguous. Answers undefined when
 * nothing matches, and throws when the selector names neither or both, or when
 * Rome holds several accounts on the platform, since picking one would send as
 * the wrong one.
 */
export async function romeAccountNamed(
  channels: ChannelsService,
  { channel, platform }: AccountSelector,
): Promise<ChannelSummary | undefined> {
  if (!channel === !platform) throw new Error("Name either `channel` or `platform`, not both.");
  const summaries = await channels.list();
  if (channel) return summaries.find((summary) => summary.name === channel);
  const held = summaries.filter((summary) => summary.sendable && summary.platform === platform);
  if (held.length > 1) {
    const names = held.map((summary) => `"${summary.name}"`).join(", ");
    throw new Error(
      `Rome has several accounts on "${platform}": ${names}. Name the one to use as \`channel\`.`,
    );
  }
  return held[0];
}

/** What `send` and `query` take for an account: its platform and id where
 *  the host names them, or else its channel's name. */
export function addressOf(summary: ChannelSummary) {
  return summary.account ?? summary.name;
}
