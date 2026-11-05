// Notion's webhooks in the common shape. A Notion event names what changed
// and who did it, by id only, so the normalizer reads the comment and its
// page to say whether it mentions the guardian, replies to them, or sits on
// a page they created.

import {
  type AddressedTo,
  drop,
  type Json,
  KIND_OFF,
  keep,
  type Normalized,
  obj,
  str,
} from "./normalize.js";
import type { WatchReads } from "./reads.js";

export interface NotionContext {
  kinds: ReadonlySet<string>;
  reads: Pick<WatchReads, "notionMe" | "notionComment" | "notionComments" | "notionPage">;
}

const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(obj) : []);

/** The plain text of a rich-text array. */
const plain = (richText: unknown) =>
  list(richText)
    .map((part) => (typeof part.plain_text === "string" ? part.plain_text : ""))
    .join("") || undefined;

/** A page's title, from whichever property holds it. */
export function titleOf(page: Json): string | undefined {
  for (const property of Object.values(obj(page.properties)).map(obj)) {
    if (property.type === "title") return plain(property.title);
  }
  return undefined;
}

/** A raw Notion event of `type` in the common shape, or why it is not one. */
export async function normalizeNotion(
  type: string,
  payload: Json,
  ctx: NotionContext,
): Promise<Normalized> {
  const eventId = str(payload.event_id);
  if (!eventId) return drop("no Notion event id");
  const kind =
    type === "notion_comment_created"
      ? "comment_or_mention"
      : type === "notion_page_created"
        ? "new_page"
        : type === "notion_page_content_updated" || type === "notion_page_properties_updated"
          ? "page_changed"
          : undefined;
  if (!kind) return drop(`Notion ${type} is not a kind follows describe`);
  if (!ctx.kinds.has(kind)) return drop(KIND_OFF);

  const me = (await ctx.reads.notionMe()).id;
  const authors = list(payload.authors);
  const byYou = authors.some((a) => str(a.id) === me);
  const bot = authors.length > 0 && authors.every((a) => str(a.type) !== "person");
  const comment = kind === "comment_or_mention" ? await commentOf(payload, ctx) : undefined;
  const pageId =
    str(payload.page_id) ?? str(obj(payload.data).page_id) ?? str(obj(comment?.parent).page_id);
  const page = pageId ? await ctx.reads.notionPage(pageId) : {};
  if (page.in_trash === true || page.archived === true) return drop("trash");
  const yourPage = str(obj(page.created_by).id) === me;
  const shared = {
    subject: titleOf(page),
    url: str(page.url),
    byYou,
  };
  const facts = [yourPage && "your-page", bot && "bot"];

  if (comment) {
    const mentioned = list(comment.rich_text).some(
      (part) => str(obj(obj(part.mention).user).id) === me,
    );
    const discussion = str(comment.discussion_id);
    const commentId = str(comment.id);
    const block = str(obj(comment.parent).block_id) ?? pageId;
    // A reply to the guardian is a comment in a discussion they wrote in.
    const thread =
      discussion && block
        ? (await ctx.reads.notionComments(block).catch(() => [])).filter(
            (c) => str(c.discussion_id) === discussion && str(c.id) !== commentId,
          )
        : [];
    const replyToYou = thread.some((c) => str(obj(c.created_by).id) === me);
    const addressedTo: AddressedTo =
      mentioned || replyToYou ? "direct" : yourPage ? "copy" : "other";
    return keep("notion", `${me}:${eventId}`, kind, {
      ...shared,
      text: plain(comment.rich_text),
      addressedTo,
      labels: [
        "comment",
        mentioned && "mention",
        thread.length > 0 && "reply",
        replyToYou && "reply-to-you",
        ...facts,
      ],
    });
  }
  return keep("notion", `${me}:${eventId}`, kind, {
    ...shared,
    addressedTo: yourPage ? "direct" : "other",
    labels: [
      kind === "new_page" ? "created" : "edited",
      type === "notion_page_properties_updated" && "properties",
      ...facts,
    ],
  });
}

/** The comment an event names, read by its id. */
async function commentOf(payload: Json, ctx: NotionContext): Promise<Json> {
  const id = str(payload.comment_id) ?? str(obj(payload.data).id);
  if (!id) throw new Error("A Notion comment event named no comment.");
  return ctx.reads.notionComment(id);
}
