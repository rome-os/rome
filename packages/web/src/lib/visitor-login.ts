import { beginAuthorizeRedirect, type AuthorizeRedirectResult } from "./authorize-redirect";

export function beginVisitorLogin(
  appId: string,
  next: string = `${window.location.pathname}${window.location.search}${window.location.hash}`,
): Promise<AuthorizeRedirectResult> {
  return beginAuthorizeRedirect("/api/auth/visitor/start", { appId, next });
}

export function beginDashboardVisitorLogin(
  next: string = `${window.location.pathname}${window.location.search}${window.location.hash}`,
): Promise<AuthorizeRedirectResult> {
  return beginAuthorizeRedirect("/api/auth/visitor/start", { scope: "dashboard", next });
}

const VISITOR_ERROR_REASONS = new Set([
  "state",
  "expired",
  "denied",
  "unconfigured",
  "exchange",
  "malformed",
  "network",
  "forbidden",
]);

export function visitorErrorReasonKey(reason: string | null): string {
  if (reason && VISITOR_ERROR_REASONS.has(reason)) {
    const camel = reason.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
    return `visitorDashboard.error${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  }
  return "visitorDashboard.errorFallback";
}
