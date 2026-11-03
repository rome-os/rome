import CookieManager from "@preeternal/react-native-cookie-manager";
import { Platform } from "react-native";
import type { InstanceSession } from "@rome-os/libs/native-auth";

export interface WebViewCookieStore {
  install(session: InstanceSession): Promise<void>;
  clear(origin: string): Promise<void>;
}

export const webViewCookieStore: WebViewCookieStore = {
  async install(session) {
    const host = new URL(session.origin).hostname;
    const stored = await CookieManager.set(
      session.origin,
      {
        name: session.cookieName,
        value: session.token,
        domain: host,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        expires: session.expiresAt,
      },
      Platform.OS === "ios",
    );
    if (!stored) throw new Error("The WebView session cookie could not be stored");
  },
  async clear(origin) {
    await CookieManager.clearByName(origin, "rome_session", Platform.OS === "ios");
  },
};
