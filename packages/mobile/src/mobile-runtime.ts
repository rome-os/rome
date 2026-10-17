import { fetch as expoFetch } from "expo/fetch";
import { CloudApi, InstanceSessionCoordinator } from "@rome-os/libs/native-auth";
import { ROME_CLOUD_ORIGIN } from "./config";
import { credentialVault } from "./credential-vault-runtime";
import { webViewCookieStore } from "./webview-cookie-store";

export const nativeFetch = expoFetch as unknown as typeof fetch;
export const cloudApi = new CloudApi(ROME_CLOUD_ORIGIN, nativeFetch);
export const sessionCoordinator = new InstanceSessionCoordinator(
  cloudApi,
  credentialVault,
  webViewCookieStore,
  nativeFetch,
);
