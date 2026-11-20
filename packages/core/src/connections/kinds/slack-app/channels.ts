// The channels Rome's Slack app is a member of, by the names people use for
// them, so a chat can be named `#news` as well as by its id.

import type { ChatId } from "@rome-os/app-runtime";
import { SlackApiError } from "../slack/slack.js";
import type { SlackAppWebApi, SlackChannel } from "./web-api.js";

/** How long a listing of the app's channels is reused before Slack is asked
 *  again. */
const MEMBER_CHANNELS_TTL_MS = 5 * 60 * 1000;
/** How old a listing may be before a name is resolved from a new one:
 *  someone may have just added the app with /invite, or renamed a channel
 *  and given its old name to another. */
const RELIST_AFTER_MS = 10 * 1000;
/** One page of Slack's listing, and how many pages a listing reads at most:
 *  a listing that would need more is refused, never taken as whole. 10,000
 *  channels is also as far as a directory page's cursor reaches. */
const PAGE = 200;
const MAX_PAGES = 50;

/** What a call that needs the channel scopes says when the workspace was
 *  connected before Rome's Slack app asked for them. */
export const REAPPROVE_FOR_CHANNELS =
  "Rome's Slack app may not see channels in this workspace yet: it was connected before the app asked for that. Ask the guardian to approve the app again from Slack in Settings › Connections.";

/** Slack's answer for a call the token holds no scope for. */
export function isMissingScope(error: unknown): boolean {
  return error instanceof SlackApiError && error.code === "missing_scope";
}

export class SlackMemberChannels {
  private cached: { at: number; channels: SlackChannel[] } | null = null;

  constructor(
    private readonly deps: {
      api: Pick<SlackAppWebApi, "memberChannels">;
      botToken: string;
      now?: () => number;
    },
  ) {}

  /** The channels the app is a member of, sorted by name. Rejects with
   *  {@link REAPPROVE_FOR_CHANNELS} where the token holds no channel scope,
   *  and rejects a listing longer than it reads. */
  async list(signal?: AbortSignal): Promise<SlackChannel[]> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.cached && now - this.cached.at < MEMBER_CHANNELS_TTL_MS) return this.cached.channels;
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const listed = await this.deps.api.memberChannels(
          this.deps.botToken,
          { limit: PAGE, ...(cursor ? { cursor } : {}) },
          signal,
        );
        channels.push(...listed.channels);
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
    } catch (error) {
      if (isMissingScope(error)) throw new Error(REAPPROVE_FOR_CHANNELS);
      throw error;
    }
    // A part of the listing would read as the whole, and a channel past it as
    // one the app is not a member of.
    if (cursor) {
      throw new Error(
        `Rome's Slack app is a member of more than ${PAGE * MAX_PAGES} channels, too many to list: name a channel by its id.`,
      );
    }
    channels.sort((a, b) => a.name.localeCompare(b.name));
    this.cached = { at: now, channels };
    return channels;
  }

  /**
   * `chatId` with a channel's name in it, such as `#news` or
   * `#news:1700000000.000100`, made the channel's id. Any other chat id is
   * answered as it is. Rejects a name no channel the app is a member of has.
   * A listing older than {@link RELIST_AFTER_MS} is read again first, and
   * `fresh` reads it again whatever its age, as a send does: a renamed
   * channel's old name may now be another channel's.
   */
  async resolve(
    chatId: string,
    signal?: AbortSignal,
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<ChatId> {
    if (!chatId.startsWith("#")) return chatId as ChatId;
    const separator = chatId.indexOf(":");
    const name = (separator === -1 ? chatId.slice(1) : chatId.slice(1, separator)).toLowerCase();
    const rest = separator === -1 ? "" : chatId.slice(separator);
    const now = this.deps.now?.() ?? Date.now();
    if (fresh || (this.cached && now - this.cached.at >= RELIST_AFTER_MS)) this.cached = null;
    const named = (await this.list(signal)).filter((channel) => channel.name === name);
    if (named.length === 0) {
      throw new Error(
        `Rome's Slack app is not a member of a channel named #${name}. Someone in Slack can add it with /invite, or name the channel by its id.`,
      );
    }
    if (named.length > 1) {
      throw new Error(
        `Rome's Slack app is a member of ${named.length} channels named #${name} (${named.map((channel) => channel.id).join(", ")}): name one by its id.`,
      );
    }
    return `${named[0]?.id}${rest}` as ChatId;
  }
}
