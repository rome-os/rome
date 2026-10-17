import { exactHttpsOrigin } from "@rome-os/libs/native-auth";

export function validateOAuthConfiguration(cloudOrigin: string, redirectUri: string): void {
  const origin = exactHttpsOrigin(cloudOrigin);
  const redirect = new URL(redirectUri);
  if (!origin || redirect.search || redirect.hash) {
    throw new Error("Mobile OAuth callback configuration is invalid");
  }

  const registeredCallback =
    redirect.protocol === "cc.romeos.mobile:" &&
    !redirect.username &&
    !redirect.password &&
    !redirect.host &&
    redirect.pathname === "/oauth/callback";

  if (!registeredCallback) {
    throw new Error("Mobile OAuth callback must match the registered redirect");
  }
}
