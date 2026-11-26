// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";

import { desktopApps, isElectronShell } from "./electron-shell";

afterEach(() => {
  Reflect.deleteProperty(window, "rome");
  document.documentElement.classList.remove("is-electron");
});

describe("isElectronShell", () => {
  it("is false in a browser, where no preload runs", () => {
    expect(isElectronShell()).toBe(false);
  });

  it("is true once the preload has exposed its bridge", () => {
    // packages/desktop/src/preload/index.ts calls exposeInMainWorld("rome", …)
    // synchronously, before any page script runs.
    window.rome = {};
    expect(isElectronShell()).toBe(true);
  });

  it("ignores the is-electron class, which lands too late to gate on", () => {
    // globals.css keys shell-only styling off this class, but the preload adds
    // it on DOMContentLoaded — after a render can already have happened.
    document.documentElement.classList.add("is-electron");
    expect(isElectronShell()).toBe(false);
  });

  it("is false where there is no window at all", () => {
    // rstest.config.mts defaults this package to the node environment, so the
    // guard is what keeps a server-side caller from throwing.
    const win = globalThis.window;
    Reflect.deleteProperty(globalThis, "window");
    try {
      expect(isElectronShell()).toBe(false);
    } finally {
      globalThis.window = win;
    }
  });
});

describe("desktopApps", () => {
  it("is null in a browser and in a Mac app without it", () => {
    expect(desktopApps()).toBeNull();
    window.rome = { device: {} };
    expect(desktopApps()).toBeNull();
  });

  it("is the Mac app's bridge when it can add apps to the Desktop", () => {
    const apps = { addToDesktop: async () => ({ path: "/Users/me/Desktop/A.app" }) };
    window.rome = { apps };
    expect(desktopApps()).toBe(apps);
  });
});
