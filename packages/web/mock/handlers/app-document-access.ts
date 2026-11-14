// Synthetic authorization state for dashboard review; no provider requests.
import { http, HttpResponse } from "msw";
import type {
  AppConnectionPolicies,
  DocumentAccessOptions,
} from "@rome/api-types/app-connection-access";
const policies = new Map<string, AppConnectionPolicies["policies"]>();
const options: DocumentAccessOptions = {
  connections: [
    {
      connectionId: "feishu-demo",
      label: "Feishu · Rome Demo",
      identity: "app",
      operation: "feishu.document.read",
      supported: true,
      authorized: true,
      scope: "docx:document:readonly",
      scopeStatus: "not_checked",
      consoles: [{ brand: "feishu", url: "https://open.feishu.cn/app" }],
    },
  ],
};
export const appDocumentAccessHandlers = [
  http.get("/api/app-connection-access/:appId/documents", () => HttpResponse.json(options)),
  http.get("/api/app-connection-access/:appId", ({ params }) =>
    HttpResponse.json({ policies: policies.get(String(params.appId)) ?? [] }),
  ),
  http.put(
    "/api/app-connection-access/:appId/:connectionId/:identity/:operation",
    async ({ params, request }) => {
      const input = (await request.json()) as {
        constraints: AppConnectionPolicies["policies"][number]["constraints"];
        expiresAt: string;
      };
      const policy = {
        appId: String(params.appId),
        connectionId: String(params.connectionId),
        identity: String(params.identity),
        operation: String(params.operation),
        constraints: input.constraints,
        expiresAt: input.expiresAt,
        grantStatus: "current" as const,
      };
      const previous = policies.get(policy.appId) ?? [];
      policies.set(policy.appId, [
        ...previous.filter(
          (item) =>
            item.connectionId !== policy.connectionId ||
            item.identity !== policy.identity ||
            item.operation !== policy.operation,
        ),
        policy,
      ]);
      return HttpResponse.json({ policy });
    },
  ),
  http.delete(
    "/api/app-connection-access/:appId/:connectionId/:identity/:operation",
    ({ params }) => {
      policies.set(
        String(params.appId),
        (policies.get(String(params.appId)) ?? []).filter(
          (item) =>
            item.connectionId !== params.connectionId ||
            item.identity !== params.identity ||
            item.operation !== params.operation,
        ),
      );
      return new HttpResponse(null, { status: 204 });
    },
  ),
];
