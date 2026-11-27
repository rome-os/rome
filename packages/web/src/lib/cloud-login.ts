import { beginAuthorizeRedirect, type AuthorizeRedirectResult } from "./authorize-redirect";

// Cloud guardian sign-in. Access control: docs/architecture/access-control.md.
// Shared by the login and connect pages — the same one-trip flow enrolls a
// vanilla instance and signs an already-bound one in.
// `chooseAccount` asks Rome Cloud to let the person pick an account instead of
// signing in the one it is already signed in to.
export function beginCloudLogin(
  options: { chooseAccount?: boolean } = {},
): Promise<AuthorizeRedirectResult> {
  return beginAuthorizeRedirect(
    "/api/auth/cloud/start",
    options.chooseAccount ? { chooseAccount: true } : undefined,
  );
}
