import { app, net, safeStorage, session, shell } from "electron";
import { hostname, release } from "os";
import { ROME_CLOUD_ORIGIN } from "../rome-cloud";
import { CloudAccount, type InstanceCookieStore } from "./account";
import { EncryptedFileStore } from "./credential-store";
import { computerPlatform } from "./sign-in";

const SESSION_COOKIE = "rome_session";

/**
 * The instance session as a host-only, Secure, HttpOnly cookie in the session
 * the main window uses, so the dashboard loads already signed in.
 */
const windowCookies: InstanceCookieStore = {
  async install(instanceSession) {
    await session.defaultSession.cookies.set({
      url: instanceSession.origin,
      name: instanceSession.cookieName,
      value: instanceSession.token,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: Math.floor(Date.parse(instanceSession.expiresAt) / 1000),
    });
  },
  async clear(origin) {
    await session.defaultSession.cookies.remove(origin, SESSION_COOKIE);
  },
};

// "Ray's MacBook Pro.local" names the same machine as "Ray's MacBook Pro".
export function deviceName(): string {
  return hostname().replace(/\.local$/i, "") || "Rome desktop";
}

/** Needs `app` ready: `safeStorage` reaches the keychain only after that. */
export function createCloudAccount(): CloudAccount {
  return new CloudAccount({
    cloudOrigin: ROME_CLOUD_ORIGIN,
    store: new EncryptedFileStore(safeStorage),
    cookies: windowCookies,
    // Chromium's network stack, so requests follow the system proxy the same
    // way the window does.
    fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
    openBrowser: (url) => shell.openExternal(url),
    device: {
      name: deviceName(),
      platform: computerPlatform(),
      appVersion: app.getVersion(),
      osVersion: release(),
    },
  });
}
