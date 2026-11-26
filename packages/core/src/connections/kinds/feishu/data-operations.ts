import { z } from "zod";
import { ProviderOperationError } from "../../errors.js";
import { number, operation, pageOf, pageParams, pagination, text, token } from "./operation.js";

export const scopesList = operation(
  "scopes.list",
  "List the tenant's scope grants for this app.",
  z.strictObject({}),
  async (_, request) => {
    const { scopes } = await request(
      { method: "GET", url: "/open-apis/application/v6/scopes" },
      z.object({
        scopes: z.array(
          z.object({ scope_name: z.string(), grant_status: z.int(), scope_type: text }),
        ),
      }),
    );
    return {
      scopes: scopes.map((s) => ({
        scopeName: s.scope_name,
        grantStatus: s.grant_status,
        scopeType: s.scope_type,
      })),
      checkedAt: new Date().toISOString(),
    };
  },
);

const wiki = "/open-apis/wiki/v2/spaces";
const bases = "/open-apis/bitable/v1/apps";
const sheetInfo = "/open-apis/sheets/v3/spreadsheets";
const wikiNode = z.object({
  space_id: z.string(),
  node_token: z.string(),
  obj_token: z.string(),
  obj_type: z.string(),
  title: text,
  parent_node_token: text,
  has_child: z.boolean(),
});
function nodeInfo(n: z.infer<typeof wikiNode>) {
  return {
    spaceId: n.space_id,
    nodeToken: n.node_token,
    objToken: n.obj_token,
    objType: n.obj_type,
    title: n.title,
    parentNodeToken: n.parent_node_token,
    hasChild: n.has_child,
  };
}
const meta = z.object({
  doc_token: z.string(),
  doc_type: z.string(),
  title: text,
  owner_id: text,
  create_time: text,
  latest_modify_time: text,
  url: text,
});
const space = z
  .object({
    space_id: z.string(),
    name: text,
    description: text,
    space_type: text,
    visibility: text,
  })
  .transform((s) => ({
    spaceId: s.space_id,
    name: s.name,
    description: s.description,
    spaceType: s.space_type,
    visibility: s.visibility,
  }));
const table = z
  .object({ table_id: z.string(), name: text, revision: number })
  .transform((t) => ({ tableId: t.table_id, name: t.name, revision: t.revision }));
const field = z
  .object({
    field_id: z.string(),
    field_name: z.string(),
    type: z.number(),
    ui_type: text,
    is_primary: z.boolean().optional(),
  })
  .transform((f) => ({
    fieldId: f.field_id,
    fieldName: f.field_name,
    type: f.type,
    uiType: f.ui_type,
    isPrimary: f.is_primary,
  }));
const record = z.object({ record_id: z.string(), fields: z.record(z.string(), z.unknown()) });
const sheet = z.object({
  sheet_id: z.string(),
  title: text,
  index: number,
  hidden: z.boolean().optional(),
  grid_properties: z.object({ row_count: number, column_count: number }).optional(),
});

export const dataOperations = [
  operation(
    "drive.inspect",
    "Inspect a Drive item's metadata.",
    z.strictObject({
      token,
      type: z.enum([
        "doc",
        "docx",
        "sheet",
        "bitable",
        "wiki",
        "file",
        "folder",
        "mindnote",
        "slides",
      ]),
    }),
    async (input, request) => {
      const result = await request(
        {
          method: "POST",
          url: "/open-apis/drive/v1/metas/batch_query",
          data: {
            request_docs: [{ doc_token: input.token, doc_type: input.type }],
            with_url: true,
          },
        },
        z.object({
          metas: z.array(meta),
          failed_list: z.array(z.object({ token: z.string(), code: z.number() })).optional(),
        }),
      );
      const failure = result.failed_list?.find((f) => f.token === input.token);
      if (failure?.code === 970003) throw new ProviderOperationError("provider_resource_denied");
      if (failure?.code === 970005) throw new ProviderOperationError("provider_not_found");
      if (failure) throw new ProviderOperationError("provider_unavailable", true);
      const m = result.metas[0];
      if (!m) throw new ProviderOperationError("provider_not_found");
      return {
        token: m.doc_token,
        type: m.doc_type,
        title: m.title,
        ownerId: m.owner_id,
        createTime: m.create_time,
        latestModifyTime: m.latest_modify_time,
        url: m.url,
      };
    },
  ),
  operation(
    "wiki.spaces",
    "List Wiki spaces accessible to the bot.",
    z.strictObject(pagination(50)),
    (input, request) =>
      request({ method: "GET", url: wiki, params: pageParams(input) }, pageOf(space)),
  ),
  operation(
    "wiki.node.get",
    "Read a Wiki node.",
    z.strictObject({ nodeToken: token }),
    async ({ nodeToken }, request) => {
      const { node } = await request(
        { method: "GET", url: wiki + "/get_node", params: { token: nodeToken } },
        z.object({ node: wikiNode.extend({ node_type: text }) }),
      );
      return { ...nodeInfo(node), nodeType: node.node_type };
    },
  ),
  operation(
    "wiki.nodes.list",
    "List the child nodes of a Wiki space or node.",
    z.strictObject({ spaceId: token, parentNodeToken: token.optional(), ...pagination(50) }),
    (input, request) =>
      request(
        {
          method: "GET",
          url: `${wiki}/${input.spaceId}/nodes`,
          params: { ...pageParams(input), parent_node_token: input.parentNodeToken },
        },
        pageOf(wikiNode.transform(nodeInfo)),
      ),
  ),
  operation(
    "base.get",
    "Read a Base's metadata.",
    z.strictObject({ appToken: token }),
    async ({ appToken }, request) => {
      const { app } = await request(
        { method: "GET", url: `${bases}/${appToken}` },
        z.object({
          app: z.object({ app_token: z.string(), name: text, revision: number, time_zone: text }),
        }),
      );
      return {
        appToken: app.app_token,
        name: app.name,
        revision: app.revision,
        timeZone: app.time_zone,
      };
    },
  ),
  operation(
    "base.tables.list",
    "List tables in a Base.",
    z.strictObject({ appToken: token, ...pagination(100) }),
    (input, request) =>
      request(
        { method: "GET", url: `${bases}/${input.appToken}/tables`, params: pageParams(input) },
        pageOf(table),
      ),
  ),
  operation(
    "base.fields.list",
    "List a Base table's fields.",
    z.strictObject({ appToken: token, tableId: token, ...pagination(100) }),
    (input, request) =>
      request(
        {
          method: "GET",
          url: `${bases}/${input.appToken}/tables/${input.tableId}/fields`,
          params: pageParams(input),
        },
        pageOf(field),
      ),
  ),
  operation(
    "base.records.list",
    "List records in a Base table or view.",
    z.strictObject({
      appToken: token,
      tableId: token,
      viewId: token.optional(),
      ...pagination(200),
    }),
    async (input, request) => {
      const page = await request(
        {
          method: "GET",
          url: `${bases}/${input.appToken}/tables/${input.tableId}/records`,
          params: { ...pageParams(input), view_id: input.viewId },
        },
        z.object({
          items: z.array(record),
          has_more: z.boolean(),
          page_token: text,
          total: number,
        }),
      );
      return {
        items: page.items.map((r) => ({ recordId: r.record_id, fields: r.fields })),
        total: page.total,
        hasMore: page.has_more,
        pageToken: page.page_token,
      };
    },
  ),
  operation(
    "sheets.info",
    "Read spreadsheet and sheet metadata.",
    z.strictObject({ spreadsheetToken: token }),
    async ({ spreadsheetToken }, request) => {
      const url = `${sheetInfo}/${spreadsheetToken}`;
      const { spreadsheet } = await request(
        { method: "GET", url },
        z.object({ spreadsheet: z.object({ title: text, url: text }) }),
      );
      const { sheets } = await request(
        { method: "GET", url: url + "/sheets/query" },
        z.object({ sheets: z.array(sheet) }),
      );
      return {
        spreadsheetToken,
        title: spreadsheet.title,
        url: spreadsheet.url,
        sheets: sheets.map((s) => ({
          sheetId: s.sheet_id,
          title: s.title,
          index: s.index,
          hidden: s.hidden,
          rowCount: s.grid_properties?.row_count,
          columnCount: s.grid_properties?.column_count,
        })),
      };
    },
  ),
  operation(
    "sheets.cells.read",
    "Read spreadsheet cells in an A1 range.",
    z.strictObject({
      spreadsheetToken: token,
      sheetId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      range: z.string().regex(/^[A-Za-z]{1,4}[0-9]{1,7}(:[A-Za-z]{1,4}[0-9]{1,7})?$/),
    }),
    async ({ spreadsheetToken, sheetId, range }, request) => {
      const result = await request(
        {
          method: "GET",
          url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(sheetId + "!" + range)}`,
          params: { valueRenderOption: "ToString", dateTimeRenderOption: "FormattedString" },
        },
        z.object({
          revision: number,
          valueRange: z.object({
            range: text,
            revision: number,
            values: z.array(z.array(z.unknown())),
          }),
        }),
      );
      return {
        spreadsheetToken,
        sheetId,
        range,
        resolvedRange: result.valueRange.range,
        revision: result.revision ?? result.valueRange.revision,
        values: result.valueRange.values,
      };
    },
  ),
];
