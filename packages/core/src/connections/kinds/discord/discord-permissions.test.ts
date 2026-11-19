import { describe, expect, it } from "@rstest/core";
import type { DiscordGet } from "./discord-history.js";
import { botReadsHistory } from "./discord-permissions.js";

// Whether the bot may read a chat's history, worked out from Discord's own
// answers: the chat, its guild's roles and owner, and the bot's member.

const GUILD = "9";
const BOT = "1";
const ROLE = "5";
const CHAT = "3";
const PARENT = "4";
const VIEW = 1n << 10n;
const HISTORY = 1n << 16n;
const ADMIN = 1n << 3n;
const BOTH = String(VIEW | HISTORY);

function discord(options: {
  everyone?: bigint;
  role?: bigint;
  owner?: string;
  overwrites?: Array<{ id: string; type: number; allow?: bigint; deny?: bigint }>;
  thread?: boolean;
}): DiscordGet {
  const overwrites = (options.overwrites ?? []).map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: String(overwrite.allow ?? 0n),
    deny: String(overwrite.deny ?? 0n),
  }));
  return async (route) => {
    if (route === `/channels/${CHAT}`) {
      return options.thread
        ? { id: CHAT, type: 11, guild_id: GUILD, parent_id: PARENT }
        : { id: CHAT, type: 0, guild_id: GUILD, permission_overwrites: overwrites };
    }
    if (route === `/channels/${PARENT}`) {
      return { id: PARENT, type: 0, guild_id: GUILD, permission_overwrites: overwrites };
    }
    if (route === `/guilds/${GUILD}`) {
      return {
        owner_id: options.owner ?? "2",
        roles: [
          { id: GUILD, permissions: String(options.everyone ?? 0n) },
          { id: ROLE, permissions: String(options.role ?? 0n) },
        ],
      };
    }
    if (route === `/guilds/${GUILD}/members/${BOT}`) return { roles: [ROLE] };
    throw Object.assign(new Error("Unknown"), { status: 404 });
  };
}

describe("botReadsHistory", () => {
  it("reads the guild's roles, then the chat's overwrites over them", async () => {
    await expect(botReadsHistory(discord({ everyone: VIEW | HISTORY }), CHAT, BOT)).resolves.toBe(
      true,
    );
    // A role overwrite on the chat takes Read Message History away.
    await expect(
      botReadsHistory(
        discord({ everyone: VIEW | HISTORY, overwrites: [{ id: ROLE, type: 0, deny: HISTORY }] }),
        CHAT,
        BOT,
      ),
    ).resolves.toBe(false);
    // The bot's own overwrite comes last and gives it back.
    await expect(
      botReadsHistory(
        discord({
          everyone: VIEW,
          overwrites: [
            { id: GUILD, type: 0, deny: VIEW },
            { id: BOT, type: 1, allow: VIEW | HISTORY },
          ],
        }),
        CHAT,
        BOT,
      ),
    ).resolves.toBe(true);
  });

  it("lets an administrator or the guild's owner read whatever the overwrites say", async () => {
    const denied = [{ id: GUILD, type: 0, deny: BigInt(BOTH) }];
    await expect(
      botReadsHistory(discord({ role: ADMIN, overwrites: denied }), CHAT, BOT),
    ).resolves.toBe(true);
    await expect(
      botReadsHistory(discord({ owner: BOT, overwrites: denied }), CHAT, BOT),
    ).resolves.toBe(true);
  });

  it("reads a thread by its parent chat's overwrites", async () => {
    await expect(
      botReadsHistory(
        discord({
          thread: true,
          role: VIEW | HISTORY,
          overwrites: [{ id: ROLE, type: 0, deny: VIEW }],
        }),
        CHAT,
        BOT,
      ),
    ).resolves.toBe(false);
  });
});
