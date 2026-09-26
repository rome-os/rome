import { BrowserWindow, session, shell } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { isQuitting } from "./lifecycle";
import { ROME_CLOUD_ORIGIN, ROME_CLOUD_PRODUCTION_ORIGIN } from "./rome-cloud";
import type { RuntimeManager } from "./runtime/manager";
import { chooseStartupSurface, shouldAutoOpenLocalDashboard } from "./startup-surface";

const PRELOAD_PATH = path.join(__dirname, "..", "preload", "index.js");
const SETTINGS_HTML = path.join(__dirname, "..", "..", "src", "renderer", "settings.html");
const ONBOARDING_HTML = path.join(__dirname, "..", "..", "src", "renderer", "onboarding.html");
const QUITTING_HTML = path.join(__dirname, "..", "..", "src", "renderer", "quitting.html");
const ONBOARDING_URL = pathToFileURL(ONBOARDING_HTML).toString();

/**
 * The Rome Cloud sources to name in the CSP.
 *
 * Production is always listed, because the dashboard's own copy of the origin
 * is baked into the image at web build time and does not follow this process's
 * override. A configured origin joins it only if it parses as an http(s)
 * origin: this value reaches a security header verbatim, where a path turns it
 * into a path-prefix that stops matching /store, and a `;` writes a directive
 * of its own.
 *
 * An unusable value is dropped rather than replaced. Substituting the default
 * would leave a build that thinks it is on staging quietly permitted to reach
 * production, and the raw value still goes to the runtime env, where a mistake
 * fails where it can be seen.
 */
export function cspSourcesForRomeCloud(configured: string): string {
  const sources = [ROME_CLOUD_PRODUCTION_ORIGIN];
  try {
    const url = new URL(configured);
    if ((url.protocol === "http:" || url.protocol === "https:") && !sources.includes(url.origin)) {
      sources.push(url.origin);
    }
  } catch {
    // Not a URL: production alone.
  }
  return sources.join(" ");
}

/**
 * Whether a response carries a document this app serves, and so should be given
 * the policy below.
 *
 * The header went on every response in the session, so a third party the window
 * had navigated to ended up carrying two policies. A resource has to satisfy
 * both, and ours names github.githubassets.com nowhere, so GitHub's sign-in
 * page arrived as unstyled HTML — Slack, favor authorization and the recharge
 * checkout all reach the window the same way. Remote documents are left alone
 * now.
 *
 * The proxy binds 127.0.0.1 and refuses every other Host, so no dashboard
 * document is ever served from `localhost`. `file:` is the packaged onboarding
 * and settings surface.
 */
export function policyAppliesTo(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "file:" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * The policy this app's own documents carry.
 *
 * Assembled apart from the handler so the directives this file exists to get
 * right can be asserted directly — dropping `frame-src`, or interpolating the
 * cloud sources into only one of the two, is otherwise invisible to tests.
 */
export function contentSecurityPolicy(cloudSources: string): string {
  return (
    "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* https://localhost:* ws://localhost:* wss://localhost:* http://127.0.0.1:* https://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:* https://www.googletagmanager.com; " +
    "img-src 'self' data: blob: http://localhost:* http://127.0.0.1:* https://*; " +
    "font-src 'self' data:; " +
    `connect-src 'self' http://localhost:* https://localhost:* ws://localhost:* wss://localhost:* http://127.0.0.1:* https://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:* http://100.*:* https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com ${cloudSources}; ` +
    `frame-src 'self' ${cloudSources};`
  );
}

async function loadStartupSurface(
  win: BrowserWindow,
  runtimeManager: RuntimeManager,
): Promise<void> {
  const startupSurface = chooseStartupSurface(
    runtimeManager.getDashboardUrl(),
    runtimeManager.isReady(),
  );
  if (startupSurface.kind === "onboarding") {
    await loadOnboarding(win);
    return;
  }

  await win.loadURL(startupSurface.url);
}

// Re-evaluate and load the startup surface for an existing window. Called when
// the runtime transitions to ready so the booting splash flips to the dashboard
// without recreating the window.
export async function reloadStartupSurface(
  win: BrowserWindow,
  runtimeManager: RuntimeManager,
): Promise<void> {
  await loadStartupSurface(win, runtimeManager);
}

export async function loadOnboarding(win: BrowserWindow): Promise<void> {
  await win.loadFile(ONBOARDING_HTML);
}

export async function loadLocalDashboard(win: BrowserWindow, url: string): Promise<void> {
  await win.loadURL(url);
}

export function shouldNavigateToLocalDashboard(
  currentUrl: string,
  localDashboardUrl: string,
): boolean {
  return shouldAutoOpenLocalDashboard(currentUrl, ONBOARDING_URL, localDashboardUrl);
}

export async function createMainWindow(runtimeManager: RuntimeManager): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: "Rome",
    frame: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // The gtag loader rides default-src — there is
  // deliberately no explicit script-src, because adding one would stop scripts
  // falling back to default-src and every local origin would have to be
  // repeated there or the dashboard breaks. Collection beacons need the GA
  // endpoints in connect-src; img-src already admits https://* for the
  // image-ping fallback.
  //
  // Rome Cloud appears in two directives because the dashboard reaches it two
  // ways: Rome News is a fetch, and the App Store sheet is an iframe of
  // /store. Without connect-src the news row renders empty; without frame-src
  // — which had no entry at all, so frames fell back to default-src — the
  // sheet opens blank.
  //
  // Both the configured origin and the production default are listed. They
  // are not the same knob: the dashboard's copy is baked into the image at web
  // build time from PANTHEON_HOST, while ROME_DESKTOP_PANTHEON_ORIGIN is read
  // here at process start. Pointing only this one at staging while running a
  // stock image would allow an origin the bundle never calls and block the one
  // it does — reproducing the blank panes this exists to fix.
  //
  // A framed page cannot reach window.rome: preload attaches to the WebContents
  // and nodeIntegrationInSubFrames is off, so no subframe gets one. It can
  // still navigate the top frame, which does carry the bridge. That belongs to
  // the frame — a sandbox without allow-top-navigation, the way FileView
  // already sandboxes its own — not here: refusing remote top-level navigation
  // from this side breaks cloud login, enrollment, visitor login and every
  // provider OAuth redirect, all of which reach Rome Cloud that way on purpose.
  //
  // Naming frame-src drops the loopback wildcards frames used to inherit from
  // default-src. Fine today: every dashboard iframe is same-origin or Rome
  // Cloud, and both are named.
  //
  // Scoping this to our own documents gives the /store frame back its own
  // policy, which is none — romeos.cc sends no CSP. What it loses is thin: this
  // one permits 'unsafe-inline', 'unsafe-eval' and img-src https://*, so it
  // stopped remote script files and nothing else. A header from romeos.cc is
  // where that belongs, and it would cover browser users too.
  const cloudSources = cspSourcesForRomeCloud(ROME_CLOUD_ORIGIN);
  const policy = contentSecurityPolicy(cloudSources);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!policyAppliesTo(details.url)) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });

  // Open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Tray-resident app: closing the window only hides it, the Lima VM and
  // Rome agent keep running. The window comes back via the tray, dock, or
  // the activate handler. A real quit goes through lifecycle.requestStopAndQuit
  // which flips isQuitting() first, so the close goes through.
  win.on("close", (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    win.hide();
  });

  await loadStartupSurface(win, runtimeManager);

  // Retry loading if the web server isn't ready
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (errorCode === -102 || errorCode === -106) {
      // ERR_CONNECTION_REFUSED or ERR_INTERNET_DISCONNECTED — retry after 2s
      setTimeout(() => {
        if (!win.isDestroyed()) {
          void loadStartupSurface(win, runtimeManager);
        }
      }, 2000);
    }
  });

  return win;
}

export function createQuittingWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 140,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    title: "Rome",
    frame: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });

  void win.loadFile(QUITTING_HTML);

  return win;
}

export function createSettingsWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Rome Settings");
  if (existing) {
    // focus() alone leaves a minimized window in the Dock, and asked from the
    // floating icon — while another app is frontmost — it can leave the window
    // behind that app.
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 500,
    minHeight: 400,
    title: "Rome Settings",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.loadFile(SETTINGS_HTML);

  return win;
}
