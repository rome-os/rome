import { beginAuthorizeRedirect, type AuthorizeRedirectResult } from "./authorize-redirect";

// Cloud guardian sign-in. Access control: docs/architecture/access-control.md.
// Shared by the login and connect pages — the same one-trip flow enrolls a
// vanilla instance and signs an already-bound one in.
export function beginCloudLogin(): Promise<AuthorizeRedirectResult> {
  return beginAuthorizeRedirect("/api/auth/cloud/start");
}
