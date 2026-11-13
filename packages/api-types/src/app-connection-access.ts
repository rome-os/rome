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
