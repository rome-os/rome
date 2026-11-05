import { describe, expect, it } from "@rstest/core";
import { NOTION_WATCHABLE } from "./index.js";
import { normalizeNotion, titleOf } from "./normalize.js";

// Webhook payloads as Composio's Notion docs list them (ids and authors only:
// docs.composio.dev/toolkits/notion), and the comment and page objects as
// Notion's API returns them.
const ALL = new Set(NOTION_WATCHABLE.kinds.map((k) => k.kind));
const ME = "user-me";
const page = (extra: Record<string, unknown> = {}) => ({
  object: "page",
  id: "page-1",
  url: "https://www.notion.so/Launch-plan-page1",
  created_by: { object: "user", id: ME },
  in_trash: false,
  properties: {
    Status: { type: "status", status: { name: "Draft" } },
    Name: { type: "title", title: [{ plain_text: "Launch " }, { plain_text: "plan" }] },
  },
  ...extra,
});
const comment = (extra: Record<string, unknown> = {}) => ({
  object: "comment",
  id: "cm-2",
  discussion_id: "d-1",
  parent: { type: "page_id", page_id: "page-1" },
  created_by: { object: "user", id: "user-ana" },
  rich_text: [
    { type: "text", plain_text: "Looks good " },
    { type: "mention", mention: { type: "user", user: { id: ME } }, plain_text: "@Mia" },
  ],
  ...extra,
});
const ctx = (
  over: {
    comment?: Record<string, unknown>;
    thread?: Record<string, unknown>[];
    page?: Record<string, unknown>;
    kinds?: ReadonlySet<string>;
  } = {},
) => ({
  kinds: over.kinds ?? ALL,
  reads: {
    notionMe: async () => ({ id: ME, email: "mia@x.io" }),
    notionComment: async () => over.comment ?? comment(),
    notionComments: async () => over.thread ?? [],
    notionPage: async () => over.page ?? page(),
  },
});
const commentEvent = {
  authors: [{ id: "user-ana", type: "person" }],
  comment_id: "cm-2",
  data: { page_id: "page-1", parent: { id: "page-1", type: "page" } },
  event_id: "ev-1",
  event_type: "comment.created",
  timestamp: "2026-11-04T10:00:00.000Z",
  workspace_id: "ws-1",
  workspace_name: "Acme",
};

describe("normalizeNotion", () => {
  it("reads a comment and its page, and gives a mention of the guardian, direct", async () => {
    expect(await normalizeNotion("notion_comment_created", commentEvent, ctx())).toEqual({
      keep: true,
      event: {
        id: "notion:user-me:ev-1",
        source: "notion",
        kind: "comment_or_mention",
        subject: "Launch plan",
        url: "https://www.notion.so/Launch-plan-page1",
        excerpt: "Looks good @Mia",
        byYou: false,
        addressedTo: "direct",
        labels: ["comment", "mention", "your-page"],
      },
    });
  });

  it("gives a reply in a discussion the guardian wrote in as direct", async () => {
    const result = await normalizeNotion(
      "notion_comment_created",
      commentEvent,
      ctx({
        comment: comment({ rich_text: [{ type: "text", plain_text: "Done" }] }),
        thread: [
          { id: "cm-1", discussion_id: "d-1", created_by: { id: ME } },
          { id: "cm-2", discussion_id: "d-1", created_by: { id: "user-ana" } },
        ],
        page: page({ created_by: { id: "user-bo" } }),
      }),
    );
    expect(result).toMatchObject({
      keep: true,
      event: { addressedTo: "direct", labels: ["comment", "reply", "reply-to-you"] },
    });
  });

  it("gives a comment on someone else's page, not to the guardian, as other", async () => {
    const result = await normalizeNotion(
      "notion_comment_created",
      commentEvent,
      ctx({
        comment: comment({ rich_text: [{ type: "text", plain_text: "Hi" }] }),
        page: page({ created_by: { id: "user-bo" } }),
      }),
    );
    expect(result).toMatchObject({
      keep: true,
      event: { addressedTo: "other", labels: ["comment"] },
    });
  });

  it("gives a change to the guardian's page, by them when they are an author", async () => {
    const event = {
      authors: [{ id: ME, type: "person" }],
      data: { parent: { id: "ws", type: "space" }, updated_blocks: [{ id: "b-1", type: "block" }] },
      event_id: "ev-9",
      event_type: "page.content_updated",
      page_id: "page-1",
      timestamp: "2026-11-04T11:00:00.000Z",
      workspace_id: "ws-1",
    };
    expect(await normalizeNotion("notion_page_content_updated", event, ctx())).toMatchObject({
      keep: true,
      event: {
        kind: "page_changed",
        subject: "Launch plan",
        byYou: true,
        addressedTo: "direct",
        labels: ["edited", "your-page"],
      },
    });
    const props = await normalizeNotion("notion_page_properties_updated", event, ctx());
    expect(props.keep && props.event.labels).toEqual(["edited", "properties", "your-page"]);
  });

  it("drops a page in the trash, a kind the follow has off, and an unknown event", async () => {
    const created = { ...commentEvent, event_type: "page.created", page_id: "page-1" };
    expect(
      await normalizeNotion(
        "notion_page_created",
        created,
        ctx({ page: page({ in_trash: true }) }),
      ),
    ).toEqual({ keep: false, reason: "trash" });
    expect(
      await normalizeNotion("notion_page_created", created, ctx({ kinds: new Set() })),
    ).toEqual({
      keep: false,
      reason: "not a kind this follow has on",
    });
    expect((await normalizeNotion("notion_view_created", created, ctx())).keep).toBe(false);
  });

  it("marks an event by integrations only as a bot's", async () => {
    const result = await normalizeNotion(
      "notion_page_created",
      { ...commentEvent, authors: [{ id: "bot-1", type: "bot" }], page_id: "page-1" },
      ctx(),
    );
    expect(result.keep && result.event.labels).toEqual(["created", "your-page", "bot"]);
  });
});

describe("titleOf", () => {
  it("reads the title from whichever property holds it", () => {
    expect(titleOf(page())).toBe("Launch plan");
    expect(titleOf({ properties: {} })).toBeUndefined();
  });
});

describe("normalizeNotion when a read fails", () => {
  it("throws when the discussion cannot be read, rather than saying it replies to no one", async () => {
    const failing = ctx();
    failing.reads.notionComments = async () => {
      throw new Error("Notion answered 502");
    };
    await expect(normalizeNotion("notion_comment_created", commentEvent, failing)).rejects.toThrow(
      "502",
    );
  });
});

describe("normalizeNotion with several authors", () => {
  it("says the guardian did it only when every author is the guardian", async () => {
    const edit = (authors: { id: string; type: string }[]) =>
      normalizeNotion(
        "notion_page_content_updated",
        { authors, event_id: "ev-7", page_id: "page-1", data: {} },
        ctx(),
      );
    const mixed = await edit([
      { id: ME, type: "person" },
      { id: "user-ana", type: "person" },
    ]);
    expect(mixed.keep && mixed.event.byYou).toBe(false);
    const none = await edit([]);
    expect(none.keep && none.event.byYou).toBe(false);
    const mine = await edit([{ id: ME, type: "person" }]);
    expect(mine.keep && mine.event.byYou).toBe(true);
  });
});
