export interface DocumentAccessOptions {
  connections: Array<{
    connectionId: string;
    label: string;
    identity: string;
    operation: string;
    supported: boolean;
    authorized: boolean;
    scope: string;
    scopeStatus: "not_checked";
    consoles: Array<{ brand: "feishu" | "lark"; url: string }>;
  }>;
  nextCursor?: number;
}

export interface AppConnectionPolicies {
  policies: Array<{
    appId: string;
    connectionId: string;
    identity: string;
    operation: string;
    constraints: Array<{ inputPointer: string; allowedValues: Array<string | number | boolean> }>;
    grantStatus: "current" | "authorization_required" | "replaced" | "unavailable";
    expiresAt: string | null;
  }>;
}

export interface AppAccessProviderGuidance {
  consoleUrl: string;
  scopesUrl?: string;
  docsUrl?: string;
  scopeCheckOperation?: string;
}

export type AppConnectionApprovalMode = "required" | "not_required";

export interface AppConnectionAccessOperationDto {
  name: string;
  sideEffect: "read-only" | "write";
  summary?: string;
  requiredScopes?: string[];
  /** Each group needs one granted scope. */
  requiredScopeGroups?: string[][];
  resourceConstraintKind?: "documentIds";
  approvalPreviewSummary?: string;
  approvalRequired?: boolean;
}

export type AppConnectionAccessPolicyDto = AppConnectionPolicies["policies"][number] & {
  sideEffect: AppConnectionAccessOperationDto["sideEffect"];
  approvalMode: AppConnectionApprovalMode;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export interface ConnectionAppAccessDto {
  connection: { connectionId: string; connectionKind: string; label: string };
  identities: Array<{
    identity: string;
    actState: import("@rome-os/app-runtime").AppConnectionCapabilityState;
    providerGuidance?: AppAccessProviderGuidance;
    operations: AppConnectionAccessOperationDto[];
  }>;
  policies: AppConnectionAccessPolicyDto[];
}

export interface PutAppConnectionAccessPolicy {
  appId: string;
  identity: string;
  operation: string;
  /** Zero expects no active policy. Omit to write unconditionally. */
  expectedRevision?: number;
  approvalMode?: AppConnectionApprovalMode;
  constraints?: AppConnectionAccessPolicyDto["constraints"];
  expiresAt?: string | null;
}

export type ConnectionAccessPreset = "read" | "read_and_write" | "custom";

export interface ApproveConnectionAccessRequest {
  expiresAt?: string | null;
}

export interface AppConnectionAccessAuditEntryDto {
  seq: number;
  appId: string;
  connectionId: string;
  identity: string;
  operation: string;
  accessRevision: number | null;
  approval: "not_required" | "pending" | "approved" | "rejected";
  executionId: string;
  requestIdHash: string | null;
  status: string;
  createdAt: string;
}

export interface AppConnectionAccessAuditPage {
  entries: AppConnectionAccessAuditEntryDto[];
  nextBeforeSeq: number | null;
}

export interface AppConnectionScopeCheck {
  status: "checked" | "unsupported" | "unavailable" | "error";
  checkedAt: string;
  scopes?: Array<{ scopeName: string; grantStatus: number; scopeType?: string }>;
  errorCode?: string;
}

const calendarRead = [
  ["calendar:calendar.event:read", "calendar:calendar:readonly", "calendar:calendar"],
];
const sheetsRead = [
  [
    "sheets:spreadsheet:readonly",
    "sheets:spreadsheet:read",
    "sheets:spreadsheet",
    "drive:drive:readonly",
    "drive:drive",
  ],
];

const feishuScopes = {
  "document.read": [["docx:document:readonly", "docx:document"]],
  "document.create": [["docx:document"]],
  "document.update": [["docx:document"]],
  "scopes.list": [],
  "drive.inspect": [["drive:drive.metadata:readonly", "drive:drive"]],
  "wiki.spaces": [["wiki:space:retrieve", "wiki:wiki:readonly", "wiki:wiki"]],
  "wiki.node.get": [["wiki:node:read", "wiki:wiki:readonly", "wiki:node:retrieve", "wiki:wiki"]],
  "wiki.nodes.list": [["wiki:node:retrieve", "wiki:wiki:readonly", "wiki:wiki"]],
  "base.get": [["base:app:read", "bitable:app:readonly", "bitable:app"]],
  "base.tables.list": [["base:table:read", "bitable:app:readonly", "bitable:app"]],
  "base.fields.list": [["base:field:read", "bitable:app:readonly", "bitable:app"]],
  "base.records.list": [["bitable:app:readonly", "bitable:app"]],
  "sheets.info": sheetsRead,
  "sheets.cells.read": sheetsRead,
  "calendar.events.list": calendarRead,
  "calendar.event.get": calendarRead,
  "calendar.events.search": calendarRead,
  "calendar.event.create": [
    ["calendar:calendar.event:create", "calendar:calendar"],
    ["calendar:calendar.event:update", "calendar:calendar"],
  ],
  "im.messages.list": [["im:message:readonly", "im:message", "im:message.history:readonly"]],
};

export function feishuOperationScopes(name: keyof typeof feishuScopes) {
  const groups = feishuScopes[name];
  return {
    requiredScopes: groups.map(([primary]) => primary),
    ...(groups.some((group) => group.length > 1) && { requiredScopeGroups: groups }),
  };
}
