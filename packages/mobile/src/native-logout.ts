import type { CloudApi, CredentialVault } from "@rome-os/libs/native-auth";
import type { WebViewCookieStore } from "./webview-cookie-store";

export async function retryPendingCloudRevocation(
  cloudApi: CloudApi,
  vault: CredentialVault,
): Promise<void> {
  const pending = await vault.getPendingCloudRevocation();
  if (!pending) return;
  try {
    if (await cloudApi.revoke(pending)) await vault.clearPendingCloudRevocation();
  } catch {
    // A quarantined token is never returned by the normal credential getter.
  }
}

export async function logoutNativeSession(input: {
  cloudApi: CloudApi;
  vault: CredentialVault;
  cookieStore: WebViewCookieStore;
  clearSelection(): Promise<void>;
}): Promise<void> {
  const credential = await input.vault.getCloudCredential();
  const origins = await input.vault.getInstanceOrigins();
  if (credential) {
    try {
      if (await input.cloudApi.revoke(credential)) await input.vault.clearCloudCredential();
      else await input.vault.quarantineCloudCredential();
    } catch {
      await input.vault.quarantineCloudCredential();
    }
  }
  await Promise.all(
    origins.map((origin) => input.cookieStore.clear(origin).catch(() => undefined)),
  );
  await input.clearSelection();
  await input.vault.clearInstanceSessions();
}
