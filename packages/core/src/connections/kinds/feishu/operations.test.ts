import { describe, expect, it } from "@rstest/core";
import { createFeishuActor, FEISHU_OPERATIONS } from "./actor.js";
import type { Endpoint } from "./transport.js";

const material = { appId: "cli_fixture", appSecret: "synthetic-only" };
function fixture(...responses: unknown[]) {
  const calls: Endpoint[] = [];
  const actor = createFeishuActor(material, undefined, async (_, endpoint) => {
    calls.push(endpoint);
    if (!responses.length) throw new Error("Unexpected provider request");
    const data = responses.shift();
    if (data instanceof Error) throw data;
    return { code: 0, data };
  });
  return {
    calls,
    invoke: (name: string, input: unknown) => actor.invoke({ operation: "feishu." + name, input }),
  };
}

const node = { space_id: "S", node_token: "N", obj_token: "D", obj_type: "docx", has_child: false };
const event = {
  event_id: "event@1",
  start_time: { timestamp: "100" },
  end_time: { date: "2026-01-02" },
  summary: "Meeting",
};
const docs = "/open-apis/docx/v1/documents";
const events = "/open-apis/calendar/v4/calendars/primary/events";
const bases = "/open-apis/bitable/v1/apps/A";
const wiki = "/open-apis/wiki/v2/spaces";
const page = (item: unknown) => ({ items: [item], has_more: true, page_token: "next" });

describe("Feishu bot read operations", () => {
  for (const [name, input, request, data, output] of [
    [
      "scopes.list",
      {},
      { url: "/open-apis/application/v6/scopes" },
      { scopes: [{ scope_name: "docs", grant_status: 1, scope_type: "tenant" }] },
      {
        scopes: [{ scopeName: "docs", grantStatus: 1, scopeType: "tenant" }],
        checkedAt: expect.any(String),
      },
    ],
    [
      "drive.inspect",
      { token: "D", type: "docx" },
      {
        method: "POST",
        url: "/open-apis/drive/v1/metas/batch_query",
        data: { request_docs: [{ doc_token: "D", doc_type: "docx" }], with_url: true },
      },
      { metas: [{ doc_token: "D", doc_type: "docx", latest_modify_time: "12" }] },
      { token: "D", type: "docx", latestModifyTime: "12" },
    ],
    [
      "wiki.spaces",
      { pageSize: 1, pageToken: "opaque&=" },
      { url: wiki, params: { page_size: 1, page_token: "opaque&=" } },
      page({ space_id: "S" }),
      { items: [{ spaceId: "S" }], hasMore: true, pageToken: "next" },
    ],
    [
      "wiki.node.get",
      { nodeToken: "N" },
      { url: wiki + "/get_node", params: { token: "N" } },
      { node: { ...node, node_type: "origin" } },
      { spaceId: "S", nodeType: "origin", hasChild: false },
    ],
    [
      "wiki.nodes.list",
      { spaceId: "S", parentNodeToken: "N" },
      { url: wiki + "/S/nodes", params: { parent_node_token: "N" } },
      page(node),
      { items: [{ objToken: "D", hasChild: false }] },
    ],
    [
      "base.get",
      { appToken: "A" },
      { url: bases },
      { app: { app_token: "A", time_zone: "UTC" } },
      { appToken: "A", timeZone: "UTC" },
    ],
    [
      "base.tables.list",
      { appToken: "A" },
      { url: bases + "/tables" },
      page({ table_id: "T" }),
      { items: [{ tableId: "T" }] },
    ],
    [
      "base.fields.list",
      { appToken: "A", tableId: "T" },
      { url: bases + "/tables/T/fields" },
      page({ field_id: "F", field_name: "Cell", type: 1, is_primary: false }),
      { items: [{ fieldId: "F", fieldName: "Cell", type: 1, isPrimary: false }] },
    ],
    [
      "base.records.list",
      { appToken: "A", tableId: "T", viewId: "V" },
      { url: bases + "/tables/T/records", params: { view_id: "V" } },
      { ...page({ record_id: "R", fields: { mixed_Key: [1, null] } }), total: 7 },
      { items: [{ recordId: "R", fields: { mixed_Key: [1, null] } }], total: 7 },
    ],
    [
      "sheets.cells.read",
      { spreadsheetToken: "A", sheetId: "s_1", range: "A1:B9" },
      {
        url: "/open-apis/sheets/v2/spreadsheets/A/values/s_1!A1%3AB9",
        params: { valueRenderOption: "ToString", dateTimeRenderOption: "FormattedString" },
      },
      { revision: 2, valueRange: { range: "s_1!A1:B9", values: [[1, null]] } },
      {
        sheetId: "s_1",
        range: "A1:B9",
        resolvedRange: "s_1!A1:B9",
        revision: 2,
        values: [[1, null]],
      },
    ],
    [
      "calendar.events.list",
      { startTime: "1970-01-01T08:00:01+08:00", endTime: "1000" },
      { url: events, params: { start_time: "1", end_time: "1000", page_size: 50 } },
      page({ ...event, organizer_calendar_id: "O" }),
      {
        calendarId: "primary",
        items: [{ startTime: "100", endTime: "2026-01-02", organizerCalendarId: "O" }],
      },
    ],
    [
      "calendar.event.get",
      { eventId: "event@1" },
      { url: events + "/event@1" },
      { event: { ...event, location: { name: "Office" }, app_link: "link" } },
      { location: "Office", url: "link", eventId: "event@1" },
    ],
    [
      "calendar.events.search",
      { query: "Meeting", startTime: "100", pageSize: 7 },
      {
        method: "POST",
        url: events + "/search",
        params: { page_size: 7 },
        data: { query: "Meeting", filter: { start_time: { timestamp: "100" } } },
      },
      { items: [event], page_token: "later" },
      { hasMore: true, pageToken: "later", items: [{ eventId: "event@1" }] },
    ],
    [
      "im.messages.list",
      { chatId: "C", sortOrder: "desc", endTime: "1000" },
      {
        url: "/open-apis/im/v1/messages",
        params: {
          container_id_type: "chat",
          container_id: "C",
          sort_type: "ByCreateTimeDesc",
          end_time: "1000",
        },
      },
      page({
        message_id: "M",
        msg_type: "text",
        create_time: "100",
        body: { content: "body" },
        sender: { id_type: "open_id", id: "U" },
      }),
      {
        chatId: "C",
        items: [{ messageId: "M", sender: { id: "U", idType: "open_id" }, bodyContent: "body" }],
      },
    ],
  ] as const) {
    it(name, async () => {
      const h = fixture({ ...data, privateProviderField: "not for apps" });
      const result = await h.invoke(name, input);
      expect(result).toMatchObject(output);
      expect(JSON.stringify(result)).not.toContain("not for apps");
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]).toMatchObject({ method: "GET", ...request });
    });
  }

  it("reads both spreadsheet metadata resources", async () => {
    const h = fixture(
      { spreadsheet: { title: "Workbook", url: "link" } },
      {
        sheets: [
          {
            sheet_id: "s",
            index: 0,
            hidden: false,
            grid_properties: { row_count: 7, column_count: 4 },
          },
        ],
      },
    );
    expect(await h.invoke("sheets.info", { spreadsheetToken: "A" })).toMatchObject({
      spreadsheetToken: "A",
      title: "Workbook",
      url: "link",
      sheets: [{ sheetId: "s", rowCount: 7, columnCount: 4, hidden: false }],
    });
    expect(h.calls.map((c) => c.url)).toEqual([
      "/open-apis/sheets/v3/spreadsheets/A",
      "/open-apis/sheets/v3/spreadsheets/A/sheets/query",
    ]);
  });

  it("declares the alternatives for drive metadata and base message history requirements", () => {
    const access = (name: string) => FEISHU_OPERATIONS.find((op) => op.name === name)?.appAccess;
    expect(access("feishu.drive.inspect")).toMatchObject({
      requiredScopes: ["drive:drive.metadata:readonly"],
      requiredScopeGroups: [["drive:drive.metadata:readonly", "drive:drive"]],
    });
    expect(access("feishu.im.messages.list")).toMatchObject({
      requiredScopes: ["im:message:readonly"],
      requiredScopeGroups: [["im:message:readonly", "im:message", "im:message.history:readonly"]],
    });
  });

  it("starts calendar pagination at an anchor and follows the returned token", async () => {
    for (const anchorTime of ["1970-01-01T08:00:01.900+08:00", "1"]) {
      const h = fixture(page(event), { items: [], has_more: false });
      const first = (await h.invoke("calendar.events.list", { anchorTime })) as {
        pageToken: string;
      };
      expect(first).toMatchObject({ hasMore: true, pageToken: "next" });
      expect(await h.invoke("calendar.events.list", { pageToken: first.pageToken })).toMatchObject({
        hasMore: false,
        items: [],
      });
      expect(h.calls.map((call) => call.params)).toEqual([
        { page_size: 50, anchor_time: "1" },
        { page_size: 50, page_token: "next" },
      ]);
    }
  });

  it("allows a calendar page token on its own and inclusive read windows at second precision", async () => {
    const h = fixture(...Array(4).fill({ items: [], has_more: false }));
    await h.invoke("calendar.events.list", { pageSize: 200, pageToken: "next" });
    expect(h.calls[0]).toMatchObject({
      url: events,
      params: { page_size: 200, page_token: "next" },
    });
    const window = { startTime: "1970-01-01T00:00:01.900Z", endTime: "1" };
    for (const [name, input] of [
      ["calendar.events.list", window],
      ["calendar.events.search", { ...window, query: "meeting" }],
      ["im.messages.list", { ...window, chatId: "C" }],
    ] as const)
      await expect(h.invoke(name, input)).resolves.toMatchObject({ items: [] });
  });

  it("rejects extra inputs for every operation and out-of-bounds values before transport", async () => {
    const h = fixture();
    for (const op of FEISHU_OPERATIONS)
      await expect(h.invoke(op.name.slice(7), { url: "https://invalid.test" })).rejects.toThrow();
    for (const [name, input] of [
      ["calendar.events.list", { calendarId: ".." }],
      ["calendar.events.list", { pageSize: 49 }],
      ["calendar.events.list", { pageSize: 201 }],
      ["calendar.events.list", { pageToken: "next", startTime: "0" }],
      ["calendar.events.list", { pageToken: "next", endTime: "0" }],
      ["calendar.events.list", { anchorTime: "0", startTime: "0" }],
      ["calendar.events.list", { anchorTime: "0", endTime: "0" }],
      ["calendar.events.list", { anchorTime: "0", pageToken: "next" }],
      ["calendar.events.list", { startTime: "11", endTime: "2" }],
      ["calendar.events.search", { query: "meeting", startTime: "11", endTime: "2" }],
      ["im.messages.list", { chatId: "C", startTime: "11", endTime: "2" }],
      ["wiki.spaces", { pageSize: 51 }],
      ["base.tables.list", { appToken: "A", pageSize: 101 }],
      ["base.records.list", { appToken: "A", tableId: "T", pageSize: 201 }],
      ["im.messages.list", { chatId: "C", pageToken: "x".repeat(4001) }],
      ["calendar.events.search", { query: "", startTime: "not a date" }],
      ["sheets.cells.read", { spreadsheetToken: "A", sheetId: "S", range: "A1:B" }],
      ["document.update", { documentId: "../D", mode: "overwrite", content: "x" }],
      [
        "calendar.event.create",
        { summary: "s", startTime: "2025-02-03T12:15:00", endTime: "2025-02-03T13:00:00Z" },
      ],
    ] as const)
      await expect(h.invoke(name, input)).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });
});

describe("Feishu writes", () => {
  it("keeps all plain text in at most 100 blocks and uses the created document's revision", async () => {
    const h = fixture(
      { document: { document_id: "D", title: "Title", revision_id: 4 } },
      { document_revision_id: 5 },
      { document_revision_id: 6 },
    );
    const content = Array.from({ length: 105 }, (_, i) => String(i)).join("\n");
    expect(
      await h.invoke("document.create", { title: "Title", folderToken: "F", content }),
    ).toEqual({ documentId: "D", title: "Title", revisionId: 6, blockCount: 100 });
    expect(h.calls[0]).toMatchObject({
      method: "POST",
      url: docs,
      data: { title: "Title", folder_token: "F" },
    });
    expect(h.calls[1]).toMatchObject({
      method: "POST",
      url: docs + "/D/blocks/D/children",
      params: { document_revision_id: 4 },
    });
    expect(h.calls[2].params?.document_revision_id).toBe(5);
    for (const call of h.calls.slice(1)) expect(call.data!.children).toHaveLength(50);
    const children = h.calls.slice(1).flatMap((call) => call.data!.children) as Array<{
      text: { elements: Array<{ text_run: { content: string } }> };
    }>;
    expect(children.map((b) => b.text.elements[0].text_run.content).join("\n")).toBe(content);
  });
  it("counts children at one revision and appends every chunk before deleting only the original prefix", async () => {
    const h = fixture(
      { document: { revision_id: 5 } },
      { items: [{}, {}], has_more: true, page_token: "next" },
      { items: [{}], has_more: false },
      { document_revision_id: 6 },
      { document_revision_id: 7 },
      { document_revision_id: 8 },
    );
    const content = Array(51).fill("a").join("\n");
    expect(
      await h.invoke("document.update", { documentId: "D", mode: "overwrite", content }),
    ).toEqual({ documentId: "D", mode: "overwrite", blocksAdded: 51, revisionId: 8 });
    const url = docs + "/D/blocks/D/children";
    expect(h.calls).toMatchObject([
      { method: "GET", url: docs + "/D" },
      { method: "GET", url, params: { document_revision_id: 5 } },
      { method: "GET", url, params: { document_revision_id: 5, page_token: "next" } },
      { method: "POST", url, params: { document_revision_id: 5 }, data: { index: -1 } },
      { method: "POST", url, params: { document_revision_id: 6 }, data: { index: -1 } },
      {
        method: "DELETE",
        url: url + "/batch_delete",
        params: { document_revision_id: 7 },
        data: { start_index: 0, end_index: 3 },
      },
    ]);
    expect(h.calls[3].data?.children).toHaveLength(50);
    expect(h.calls[4].data?.children).toHaveLength(1);
    const append = fixture({ document_revision_id: 9 }, { document_revision_id: 10 });
    await append.invoke("document.update", { documentId: "D", mode: "append", content });
    expect(append.calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(append.calls[1].params?.document_revision_id).toBe(9);
  });
  it("keeps the original prefix if a later append fails or omits its revision", async () => {
    for (const failure of [new Error("rate limited"), {}]) {
      const h = fixture(
        { document: { revision_id: 4 } },
        { items: [{}], has_more: false },
        { document_revision_id: 5 },
        failure,
      );
      await expect(
        h.invoke("document.update", {
          documentId: "D",
          mode: "overwrite",
          content: Array(51).fill("x").join("\n"),
        }),
      ).rejects.toThrow();
      expect(h.calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "POST"]);
    }
  });
  it("requires valid provider ids before a follow-up write and rejects incomplete pagination before deletion", async () => {
    const h = fixture({ document: { document_id: "../../other", title: "t" } });
    await expect(h.invoke("document.create", { title: "t", content: "x" })).rejects.toThrow(
      "provider_response_invalid",
    );
    expect(h.calls).toHaveLength(1);
    const broken = fixture({ document: { revision_id: 4 } }, { items: [{}], has_more: true });
    await expect(
      broken.invoke("document.update", { documentId: "D", mode: "overwrite", content: "x" }),
    ).rejects.toThrow("provider_response_invalid");
    expect(broken.calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });
  it("creates an event before inviting the requested open ids", async () => {
    const h = fixture({ event: { event_id: "E", app_link: "link" } }, { attendees: [{}] });
    const input = {
      summary: "Meeting",
      startTime: "1970-01-01T00:00:01Z",
      endTime: "1970-01-01T00:01:00Z",
      attendeeOpenIds: ["ou_demo-1"],
    };
    const descriptor = FEISHU_OPERATIONS.find((op) => op.name === "feishu.calendar.event.create")!;
    expect(descriptor.inputSchema).toMatchObject({
      properties: { attendeeOpenIds: { items: { pattern: "^ou_[a-zA-Z0-9_-]{1,125}$" } } },
    });
    for (const invalid of ["oc_demo", "u"]) {
      const bad = { ...input, attendeeOpenIds: [...input.attendeeOpenIds, invalid] };
      expect(descriptor.validateInput?.(bad)).toBe(false);
      await expect(h.invoke("calendar.event.create", bad)).rejects.toThrow();
    }
    expect(h.calls).toHaveLength(0);
    expect(await h.invoke("calendar.event.create", input)).toMatchObject({
      calendarId: "primary",
      eventId: "E",
      summary: "Meeting",
      startTime: "1",
      endTime: "60",
      attendeesAdded: 1,
    });
    expect(h.calls).toMatchObject([
      {
        method: "POST",
        url: events,
        data: { start_time: { timestamp: "1" }, end_time: { timestamp: "60" } },
      },
      {
        method: "POST",
        url: events + "/E/attendees",
        params: { user_id_type: "open_id" },
        data: { attendees: [{ type: "user", user_id: "ou_demo-1" }] },
      },
    ]);
  });
});

it("keeps the bot usable after a missing scope or denied resource", async () => {
  for (const [raw, reason] of [
    [{ code: 99991672 }, "provider_scope_required"],
    [{ code: 131006 }, "provider_resource_denied"],
    [{ code: 1254302 }, "provider_resource_denied"],
    [{ code: 193001 }, "provider_not_found"],
    [
      { code: 0, data: { metas: [], failed_list: [{ token: "D", code: 970003 }] } },
      "provider_resource_denied",
    ],
  ] as const) {
    let response: unknown = raw;
    const actor = createFeishuActor(material, undefined, async () => response);
    await expect(
      actor.invoke({ operation: "feishu.drive.inspect", input: { token: "D", type: "docx" } }),
    ).rejects.toMatchObject({ reason });
    response = { code: 0, data: { scopes: [] } };
    expect(await actor.invoke({ operation: "feishu.scopes.list", input: {} })).toMatchObject({
      scopes: [],
    });
  }
});
