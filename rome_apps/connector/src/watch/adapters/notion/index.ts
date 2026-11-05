// Notion: workspace-wide webhooks. Their payloads carry ids only, so the
// normalizer reads the comment and the page.

import { composioAdapter, fromComposio } from "../../shared/composio.js";
import type { ComposioTriggerSpec, Watchable } from "../../types.js";
import { normalizeNotion } from "./normalize.js";
import { notionReads } from "./reads.js";

const notion = (slug: string, unscoped: string[]): ComposioTriggerSpec => ({
  toolkit: "notion",
  slug,
  config: {},
  unscoped,
});
export const NOTION_COMMENT_CREATED = notion("NOTION_COMMENT_CREATED", ["page_id"]);
export const NOTION_PAGE_CONTENT_UPDATED = notion("NOTION_PAGE_CONTENT_UPDATED", [
  "data_source_id",
  "page_id",
  "parent_page_id",
]);
export const NOTION_PAGE_PROPERTIES_UPDATED = notion("NOTION_PAGE_PROPERTIES_UPDATED", [
  "data_source_id",
  "page_id",
  "parent_page_id",
]);
export const NOTION_PAGE_CREATED = notion("NOTION_PAGE_CREATED", [
  "data_source_id",
  "parent_page_id",
]);

export const NOTION_WATCHABLE: Watchable = {
  source: "notion",
  label: "Notion",
  target: null,
  kinds: [
    {
      kind: "comment_or_mention",
      label: "Comments that mention or reply to me",
      default: true,
      triggers: [fromComposio(NOTION_COMMENT_CREATED)],
    },
    {
      kind: "page_changed",
      label: "Changes to my pages",
      default: true,
      triggers: [
        fromComposio(NOTION_PAGE_CONTENT_UPDATED),
        fromComposio(NOTION_PAGE_PROPERTIES_UPDATED),
      ],
    },
    {
      kind: "new_page",
      label: "New pages",
      default: false,
      triggers: [fromComposio(NOTION_PAGE_CREATED)],
    },
  ],
  options: [
    {
      key: "pages",
      label: "Pages to hear about",
      type: "enum",
      values: [
        { value: "mine", label: "Pages I created" },
        { value: "all", label: "Any page Rome can see" },
      ],
      default: "mine",
    },
  ],
};

export const notionAdapter = composioAdapter({
  catalog: NOTION_WATCHABLE,
  triggers: [
    NOTION_COMMENT_CREATED,
    NOTION_PAGE_CONTENT_UPDATED,
    NOTION_PAGE_PROPERTIES_UPDATED,
    NOTION_PAGE_CREATED,
  ],
  async account(env, service) {
    const me = await notionReads(env, service).notionMe();
    return me.email ?? me.name ?? me.id ?? me.workspace ?? me.botId ?? "";
  },
  normalize: (env, { type, payload, kinds, service }) =>
    normalizeNotion(type, payload, {
      kinds,
      reads: notionReads(env, service),
    }),
});
