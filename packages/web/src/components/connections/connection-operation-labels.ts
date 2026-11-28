import type {
  AppConnectionAccessOperationDto,
  ConnectionAppAccessDto,
} from "@rome/api-types/app-connection-access";

type ProviderGuidance = ConnectionAppAccessDto["identities"][number]["providerGuidance"];

export type OperationGroupKey =
  | "document"
  | "drive"
  | "wiki"
  | "base"
  | "sheets"
  | "calendar"
  | "im"
  | "scopes"
  | "other";

export const KNOWN_GROUPS: ReadonlySet<OperationGroupKey> = new Set([
  "document",
  "drive",
  "wiki",
  "base",
  "sheets",
  "calendar",
  "im",
  "scopes",
]);

export const GROUP_ORDER: readonly OperationGroupKey[] = [
  "document",
  "drive",
  "wiki",
  "base",
  "sheets",
  "calendar",
  "im",
  "scopes",
  "other",
];

/** Canonical i18n key under `connectionAppAccess.operations.<key>` for known operations. */
export const KNOWN_OPERATION_KEYS: ReadonlySet<string> = new Set([
  "feishu.scopes.list",
  "feishu.document.read",
  "feishu.document.create",
  "feishu.document.update",
  "feishu.drive.inspect",
  "feishu.wiki.spaces",
  "feishu.wiki.node.get",
  "feishu.wiki.nodes.list",
  "feishu.base.get",
  "feishu.base.tables.list",
  "feishu.base.fields.list",
  "feishu.base.records.list",
  "feishu.sheets.info",
  "feishu.sheets.cells.read",
  "feishu.calendar.events.list",
  "feishu.calendar.event.get",
  "feishu.calendar.events.search",
  "feishu.calendar.event.create",
  "feishu.im.messages.list",
]);

const FEISHU_OPERATION_DOC_PATHS: Readonly<Record<string, string>> = {
  "feishu.scopes.list": "/document/uAjLw4CM/ukTMukTMukTM/application-v6/scope/list",
  "feishu.document.read": "/document/server-docs/docs/docs/docx-v1/document/raw_content",
  "feishu.document.create": "/document/server-docs/docs/docs/docx-v1/document/create",
  "feishu.document.update": "/document/server-docs/docs/docs/docx-v1/document-block/create",
  "feishu.drive.inspect": "/document/server-docs/docs/drive-v1/file/batch_query",
  "feishu.wiki.spaces": "/document/server-docs/docs/wiki-v2/space/list",
  "feishu.wiki.node.get": "/document/server-docs/docs/wiki-v2/space-node/get_node",
  "feishu.wiki.nodes.list": "/document/server-docs/docs/wiki-v2/space-node/list",
  "feishu.base.get": "/document/server-docs/docs/bitable-v1/app/get",
  "feishu.base.tables.list": "/document/server-docs/docs/bitable-v1/app-table/list",
  "feishu.base.fields.list": "/document/server-docs/docs/bitable-v1/app-table-field/list",
  "feishu.base.records.list": "/document/server-docs/docs/bitable-v1/app-table-record/list",
  "feishu.sheets.info": "/document/server-docs/docs/sheets-v3/spreadsheet/get",
  "feishu.sheets.cells.read":
    "/document/server-docs/docs/sheets-v3/data-operation/reading-a-single-range",
  "feishu.calendar.events.list": "/document/server-docs/calendar-v4/calendar-event/list",
  "feishu.calendar.event.get": "/document/server-docs/calendar-v4/calendar-event/get",
  "feishu.calendar.events.search": "/document/server-docs/calendar-v4/calendar-event/search",
  "feishu.calendar.event.create": "/document/server-docs/calendar-v4/calendar-event/create",
  "feishu.im.messages.list": "/document/server-docs/im-v1/message/list",
};

export function operationGroupKey(
  operationName: string,
  connectionKind?: string,
): OperationGroupKey {
  const segments = operationName.split(".");
  const candidate = connectionKind && segments[0] === connectionKind ? segments[1] : segments[0];
  if (!candidate || segments.length < 2) return "other";
  return KNOWN_GROUPS.has(candidate as OperationGroupKey)
    ? (candidate as OperationGroupKey)
    : "other";
}

export function operationI18nKey(operationName: string): string | null {
  return KNOWN_OPERATION_KEYS.has(operationName) ? operationName.replaceAll(".", "_") : null;
}

export function providerDocOrigin(guidance?: ProviderGuidance | null): string | null {
  for (const candidate of [guidance?.docsUrl, guidance?.scopesUrl, guidance?.consoleUrl]) {
    if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      // Ignore malformed URLs and try the next guidance link.
    }
  }
  return null;
}

export function operationDocUrl(
  operationName: string,
  guidance?: ProviderGuidance | null,
): string | null {
  const feishuPath = FEISHU_OPERATION_DOC_PATHS[operationName];
  if (feishuPath) {
    const origin = providerDocOrigin(guidance) ?? "https://open.feishu.cn";
    return `${origin}${feishuPath}`;
  }
  if (guidance?.docsUrl && /^https?:\/\//i.test(guidance.docsUrl)) {
    return guidance.docsUrl;
  }
  return null;
}

export function primaryPermissionIds(
  operation: Pick<
    AppConnectionAccessOperationDto,
    "name" | "requiredScopes" | "requiredScopeGroups"
  >,
): string[] {
  if (operation.requiredScopes?.length) {
    return [...new Set(operation.requiredScopes)];
  }
  if (operation.requiredScopeGroups?.length) {
    const ids = operation.requiredScopeGroups
      .map((group) => group[0])
      .filter((scope): scope is string => Boolean(scope));
    if (ids.length) return [...new Set(ids)];
  }
  return [operation.name];
}

export function extraPermissionIds(
  operation: Pick<
    AppConnectionAccessOperationDto,
    "name" | "requiredScopes" | "requiredScopeGroups"
  >,
): string[] {
  const primary = new Set(primaryPermissionIds(operation));
  const extras: string[] = [];
  const seen = new Set<string>();
  for (const group of operation.requiredScopeGroups ?? []) {
    for (const scope of group) {
      if (primary.has(scope) || seen.has(scope)) continue;
      seen.add(scope);
      extras.push(scope);
    }
  }
  return extras;
}

export function scopeRequirements(
  operation: Pick<AppConnectionAccessOperationDto, "requiredScopes" | "requiredScopeGroups">,
  language: string,
) {
  const alternatives = operation.requiredScopeGroups ?? [];
  const grouped = new Set(alternatives.flat());
  const standalone = operation.requiredScopes?.filter((scope) => !grouped.has(scope)) ?? [];
  const groups = [...alternatives, ...standalone.map((scope) => [scope])];
  const format = new Intl.ListFormat(language, { type: "disjunction" });
  return groups.map((scopes) => ({ scopes, label: format.format(scopes) }));
}

export function parseDocumentIds(input: string): string[] | null {
  const ids = new Set<string>();
  for (const part of input.split(/[,\n]/)) {
    let id = part.trim();
    if (!id) continue;
    if (/^https:\/\//i.test(id)) {
      let url: URL;
      try {
        url = new URL(id);
      } catch {
        return null;
      }
      if (
        url.username ||
        url.password ||
        !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname)
      ) {
        return null;
      }
      id = /^\/docx\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? "";
    }
    if (!/^[a-zA-Z0-9]{1,128}$/.test(id)) return null;
    ids.add(id);
  }
  return ids.size <= 100 ? [...ids] : null;
}
