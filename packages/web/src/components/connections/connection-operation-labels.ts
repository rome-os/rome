import type { AppConnectionAccessOperationDto } from "@rome/api-types/app-connection-access";

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

export function expiryPresetToIso(preset: "never" | "7d" | "30d"): string | null {
  if (preset === "never") return null;
  const days = preset === "7d" ? 7 : 30;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
