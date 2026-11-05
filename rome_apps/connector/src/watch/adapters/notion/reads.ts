// What the Notion normalizer reads: the connected user, a comment, the
// comments on a block, and a page, through the connected account. Tests
// inject their own.

import { identityOf, record, required, text } from "../../shared/composio.js";
import type { ComposioToolkit, Json, WatchEnv } from "../../types.js";

/**
 * The connected Notion user, who owns Rome's integration in their workspace.
 * An integration the workspace owns names no user, so `id` is unknown then:
 * events still flow, but none is the guardian's by authorship.
 */
export interface NotionMe {
  id?: string;
  email?: string;
  name?: string;
  workspace?: string;
  /** The integration's own bot id, which names the account when no user does. */
  botId?: string;
}

/** Who `/users/me` says is connected: the bot's owning user, or none when the workspace owns it. */
export function notionIdentity(me: Json): NotionMe {
  const bot = record(me.bot);
  const owner = record(record(bot.owner).user);
  const id = text(owner.id) ?? (text(me.type) === "person" ? text(me.id) : undefined);
  const email = text(record(owner.person).email)?.toLowerCase();
  const name = text(owner.name);
  const workspace = text(bot.workspace_name);
  const botId = text(me.type) === "bot" ? text(me.id) : undefined;
  return {
    ...(id ? { id } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(workspace ? { workspace } : {}),
    ...(botId ? { botId } : {}),
  };
}

export interface NotionReads {
  notionMe(): Promise<NotionMe>;
  /** A Notion comment object. */
  notionComment(id: string): Promise<Json>;
  /** The comments on a Notion page or block, oldest first. */
  notionComments(blockId: string): Promise<Json[]>;
  /** A Notion page object. */
  notionPage(id: string): Promise<Json>;
}

const NOTION_HEADERS = { "Notion-Version": "2022-06-28" };

export function notionReads(env: WatchEnv, service: ComposioToolkit): NotionReads {
  const read = (path: string, query?: Record<string, string>) =>
    env.composio.read(service, {
      endpoint: `https://api.notion.com/v1/${path}`,
      headers: NOTION_HEADERS,
      ...(query ? { query } : {}),
    });
  return {
    // The person who connected Notion: the owner of Rome's integration in their workspace.
    notionMe: () =>
      identityOf(env, service, async () => {
        const me = notionIdentity(await read("users/me"));
        // Nothing at all to name the account by is a failure to say.
        required(service, me.id ?? me.workspace ?? me.botId);
        return me;
      }),
    notionComment: (id) => read(`comments/${encodeURIComponent(id)}`),
    async notionComments(blockId) {
      const list = await read("comments", { block_id: blockId, page_size: "100" });
      return (Array.isArray(list.results) ? list.results : []).map(record);
    },
    notionPage: (id) => read(`pages/${encodeURIComponent(id)}`),
  };
}
