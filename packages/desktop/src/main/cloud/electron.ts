import { app, net, safeStorage, session, shell } from "electron";
import { hostname, release } from "os";
import { ROME_CLOUD_ORIGIN } from "../rome-cloud";
import { CloudAccount, type InstanceCookieStore } from "./account";
import { EncryptedFileStore } from "./credential-store";
import { computerPlatform } from "./sign-in";

const SESSION_COOKIES = ["rome_session", "rome_visitor"] as const;

/**
 * The instance session as a host-only, Secure, HttpOnly cookie in the session
 * the main window uses, so the dashboard loads already signed in. The window
 * holds one of the guardian's and a visitor's at a time for each origin.
 */
const windowCookies: InstanceCookieStore = {
  async install(instanceSession) {
    for (const name of SESSION_COOKIES) {
      if (name !== instanceSession.cookieName) {
        await session.defaultSession.cookies.remove(instanceSession.origin, name);
      }
    }
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
    for (const name of SESSION_COOKIES) {
      await session.defaultSession.cookies.remove(origin, name);
    }
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
