import type {
  AppConnectionAccessAuditEntryDto,
  AppConnectionAccessAuditPage,
  AppConnectionAccessPolicyDto,
  AppConnectionScopeCheck,
  ConnectionAppAccessDto,
  PutAppConnectionAccessPolicy,
} from "@rome/api-types/app-connection-access";
import { http, HttpResponse } from "msw";
import { feishuOperationScopes } from "@rome/api-types/app-connection-access";
import { connections } from "./connections-store";

const endpoint = "/api/app-connection-access/connections/:connectionId";
const operations: ConnectionAppAccessDto["identities"][number]["operations"] = [
  {
    name: "feishu.scopes.list",
    sideEffect: "read-only",
    ...feishuOperationScopes("scopes.list"),
  },
  {
    name: "feishu.document.read",
    sideEffect: "read-only",
    ...feishuOperationScopes("document.read"),
    resourceConstraintKind: "documentIds",
  },
  {
    name: "feishu.document.update",
    sideEffect: "write",
    ...feishuOperationScopes("document.update"),
    resourceConstraintKind: "documentIds",
    approvalRequired: true,
    approvalPreviewSummary: "Update Feishu document",
  },
  {
    name: "feishu.drive.inspect",
    sideEffect: "read-only",
    ...feishuOperationScopes("drive.inspect"),
  },
  {
    name: "feishu.im.messages.list",
    sideEffect: "read-only",
    ...feishuOperationScopes("im.messages.list"),
  },
  {
    name: "feishu.wiki.spaces",
    sideEffect: "read-only",
    ...feishuOperationScopes("wiki.spaces"),
  },
  {
    name: "feishu.calendar.events.list",
    sideEffect: "read-only",
    ...feishuOperationScopes("calendar.events.list"),
  },
  {
    name: "feishu.calendar.event.create",
    sideEffect: "write",
    approvalRequired: true,
    approvalPreviewSummary: "Create Feishu calendar event",
    ...feishuOperationScopes("calendar.event.create"),
  },
];
const policies: AppConnectionAccessPolicyDto[] = [];
const audit: AppConnectionAccessAuditEntryDto[] = Array.from({ length: 32 }, (_, index) => {
  const read = index % 2 === 0;
  return {
    seq: 32 - index,
    appId: read ? "fitness-tracker" : "stock-daily",
    connectionId: "feishu-demo",
    identity: "app",
    operation: read ? "feishu.document.read" : "feishu.document.update",
    accessRevision: 1,
    approval: read ? "not_required" : "approved",
    executionId: `execution-${index + 1}`,
    requestIdHash: read ? null : `demo-hash-${index + 1}`,
    status: index === 3 ? "outcome_unknown" : index === 1 ? "provider_error" : "succeeded",
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
  };
});
let revision = 0;

function isActive(policy: AppConnectionAccessPolicyDto) {
  return !policy.expiresAt || Date.parse(policy.expiresAt) > Date.now();
}

export const appConnectionAccessHandlers = [
  http.get(endpoint, ({ params }) => {
    const connection = connections.connections.find((item) => item.id === params.connectionId);
    if (!connection) return HttpResponse.json({ error: "Connection not found." }, { status: 404 });
    return HttpResponse.json({
      connection: {
        connectionId: String(params.connectionId),
        connectionKind: connection.connectionKind,
        label: connection.label,
      },
      identities:
        connection.connectionKind === "feishu"
          ? [
              {
                identity: "app",
                actState: connection.state === "working" ? "available" : "needs_authorization",
                providerGuidance: {
                  consoleUrl: "https://open.feishu.cn/app",
                  scopesUrl: "https://open.feishu.cn/app",
                  docsUrl:
                    "https://open.feishu.cn/document/server-docs/application-scope/introduction",
                  scopeCheckOperation: "feishu.scopes.list",
                },
                operations,
              },
            ]
          : [],
      policies: policies.filter(
        (policy) => policy.connectionId === connection.id && isActive(policy),
      ),
    } satisfies ConnectionAppAccessDto);
  }),
  http.post(`${endpoint}/scopes/check`, ({ params }) => {
    const checkedAt = new Date().toISOString();
    const connection = connections.connections.find((item) => item.id === params.connectionId);
    if (!connection) return HttpResponse.json({ error: "Connection not found." }, { status: 404 });
    const result: AppConnectionScopeCheck =
      connection.connectionKind !== "feishu"
        ? { status: "unsupported", checkedAt }
        : connection.state !== "working"
          ? { status: "unavailable", checkedAt }
          : {
              status: "checked",
              checkedAt,
              scopes: [
                { scopeName: "docx:document:readonly", grantStatus: 1, scopeType: "tenant" },
                { scopeName: "drive:drive.metadata:readonly", grantStatus: 1, scopeType: "tenant" },
                { scopeName: "im:message:readonly", grantStatus: 1, scopeType: "tenant" },
                { scopeName: "wiki:wiki:readonly", grantStatus: 1, scopeType: "tenant" },
                { scopeName: "calendar:calendar", grantStatus: 1, scopeType: "user" },
              ],
            };
    return HttpResponse.json(result);
  }),
  http.put(`${endpoint}/policies`, async ({ params, request }) => {
    const { expectedRevision, ...input } = (await request.json()) as PutAppConnectionAccessPolicy;
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    )
      return HttpResponse.json({ error: "Invalid access policy." }, { status: 400 });
    const connectionId = String(params.connectionId);
    const operation = operations.find((item) => item.name === input.operation);
    if (!operation) return HttpResponse.json({ error: "Operation not found." }, { status: 404 });
    const index = policies.findIndex(
      (policy) =>
        policy.connectionId === connectionId &&
        policy.appId === input.appId &&
        policy.identity === input.identity &&
        policy.operation === input.operation,
    );
    const existing = policies[index];
    const currentRevision = existing && isActive(existing) ? existing.revision : 0;
    if (expectedRevision !== undefined && expectedRevision !== currentRevision)
      return HttpResponse.json(
        { error: "policy_conflict", message: "The access policy changed. Refresh and try again." },
        { status: 409 },
      );
    const updatedAt = new Date().toISOString();
    const policy: AppConnectionAccessPolicyDto = {
      ...input,
      connectionId,
      sideEffect: operation.sideEffect,
      approvalMode:
        input.approvalMode ?? (operation.approvalRequired ? "required" : "not_required"),
      constraints: input.constraints ?? [],
      expiresAt: input.expiresAt ?? null,
      grantStatus: "current",
      createdAt: policies[index]?.createdAt ?? updatedAt,
      updatedAt,
      revision: ++revision,
    };
    if (index === -1) policies.push(policy);
    else policies[index] = policy;
    return HttpResponse.json({ policy });
  }),
  http.delete(`${endpoint}/policies/:appId/:identity/:operation`, ({ params }) => {
    const index = policies.findIndex(
      (policy) =>
        policy.connectionId === params.connectionId &&
        policy.appId === params.appId &&
        policy.identity === params.identity &&
        policy.operation === params.operation,
    );
    if (index === -1)
      return HttpResponse.json({ error: "Access policy not found." }, { status: 404 });
    policies.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${endpoint}/audit`, ({ params, request }) => {
    const query = new URL(request.url).searchParams;
    const appId = query.get("appId");
    const beforeSeq = Number(query.get("beforeSeq") ?? Infinity);
    const limit = Number(query.get("limit") ?? 30);
    const rows = audit.filter(
      (entry) =>
        entry.connectionId === params.connectionId &&
        (!appId || entry.appId === appId) &&
        entry.seq < beforeSeq,
    );
    const entries = rows.slice(0, limit);
    return HttpResponse.json({
      entries,
      nextBeforeSeq: rows.length > entries.length ? (entries.at(-1)?.seq ?? null) : null,
    } satisfies AppConnectionAccessAuditPage);
  }),
];
