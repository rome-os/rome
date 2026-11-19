/**
 * Whether Rome's bot may read a guild chat's history, worked out from what
 * Discord answers now rather than what the gateway last heard. Discord answers
 * a bot without Read Message History an empty history, not a refusal, so a
 * read asks this first. Every request goes through the caller's `get`, so a
 * read's cancellation covers it. Discord's rules:
 * https://docs.discord.com/developers/topics/permissions#permission-overwrites
 */

import type { DiscordGet } from "./discord-history.js";

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const THREADS = new Set([10, 11, 12]);

interface Overwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

interface WireGuildChannel {
  id: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
  permission_overwrites?: Overwrite[];
}

/** Whether `botId` holds View Channel and Read Message History in guild chat
 *  `chatId`, or null when the chat is in no guild. Rejects as `get` does. */
export async function botReadsHistory(
  get: DiscordGet,
  chatId: string,
  botId: string,
): Promise<boolean | null> {
  const chat = (await get(`/channels/${chatId}`)) as WireGuildChannel;
  const guildId = chat.guild_id;
  if (!guildId) return null;
  // A thread takes its parent chat's overwrites.
  const source =
    THREADS.has(chat.type) && chat.parent_id
      ? ((await get(`/channels/${chat.parent_id}`)) as WireGuildChannel)
      : chat;
  const [guild, member] = (await Promise.all([
    get(`/guilds/${guildId}`),
    get(`/guilds/${guildId}/members/${botId}`),
  ])) as [
    { owner_id: string; roles: Array<{ id: string; permissions: string }> },
    { roles: string[] },
  ];
  if (guild.owner_id === botId) return true;
  const roles = new Set(member.roles);
  let permissions = 0n;
  for (const role of guild.roles) {
    if (role.id === guildId || roles.has(role.id)) permissions |= BigInt(role.permissions);
  }
  if (permissions & ADMINISTRATOR) return true;
  const overwrites = source.permission_overwrites ?? [];
  const apply = (allow: bigint, deny: bigint) => {
    permissions = (permissions & ~deny) | allow;
  };
  const everyone = overwrites.find((overwrite) => overwrite.id === guildId);
  if (everyone) apply(BigInt(everyone.allow), BigInt(everyone.deny));
  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && overwrite.id !== guildId && roles.has(overwrite.id)) {
      allow |= BigInt(overwrite.allow);
      deny |= BigInt(overwrite.deny);
    }
  }
  apply(allow, deny);
  const own = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === botId);
  if (own) apply(BigInt(own.allow), BigInt(own.deny));
  const needed = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
  return (permissions & needed) === needed;
}
