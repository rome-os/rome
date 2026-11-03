import { beginAuthorizeRedirect, type AuthorizeRedirectResult } from "./authorize-redirect";

// Instance enrollment flow. Deployment model: docs/concepts/deployment.md.
// Shared by the connect page and the settings "reconnect" affordance.
export function beginInstanceEnroll(): Promise<AuthorizeRedirectResult> {
  return beginAuthorizeRedirect("/api/instance/enroll/start");
}
