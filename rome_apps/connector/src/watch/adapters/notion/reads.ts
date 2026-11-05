// What the Notion normalizer reads: the connected user, a comment, the
// comments on a block, and a page, through the connected account. Tests
// inject their own.

import { identityOf, record, required, text } from "../../shared/composio.js";
import type { ComposioToolkit, Json, WatchEnv } from "../../types.js";

/** The connected Notion user, who owns Rome's integration in their workspace. */
export interface NotionMe {
  id: string;
  email?: string;
  name?: string;
  workspace?: string;
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
        const me = await read("users/me");
        const owner = record(record(record(me.bot).owner).user);
        const id = text(owner.id) ?? (text(me.type) === "person" ? text(me.id) : undefined);
        return {
          id: required(service, id),
          ...(text(record(owner.person).email)
            ? { email: text(record(owner.person).email)?.toLowerCase() }
            : {}),
          ...(text(owner.name) ? { name: text(owner.name) } : {}),
          ...(text(record(me.bot).workspace_name)
            ? { workspace: text(record(me.bot).workspace_name) }
            : {}),
        };
      }),
    notionComment: (id) => read(`comments/${encodeURIComponent(id)}`),
    async notionComments(blockId) {
      const list = await read("comments", { block_id: blockId, page_size: "100" });
      return (Array.isArray(list.results) ? list.results : []).map(record);
    },
    notionPage: (id) => read(`pages/${encodeURIComponent(id)}`),
  };
}
