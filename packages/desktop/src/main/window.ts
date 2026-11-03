import { BrowserWindow, session, shell } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { isQuitting } from "./lifecycle";
import type { Runtime } from "./runtime/runtime";
import {
  chooseStartupSurface,
  shouldAutoOpenDashboard,
  shouldReturnToDashboard,
} from "./startup-surface";

const PRELOAD_PATH = path.join(__dirname, "..", "preload", "index.js");
const SETTINGS_HTML = path.join(__dirname, "..", "..", "src", "renderer", "settings.html");
const ONBOARDING_HTML = path.join(__dirname, "..", "..", "src", "renderer", "onboarding.html");
const ONBOARDING_URL = pathToFileURL(ONBOARDING_HTML).toString();

/**
 * Whether a response carries a document this app serves, and so should be given
 * the policy below: the packaged welcome, settings and pill pages, all `file:`.
 *
 * The Rome the window opens is a website with its own headers, served the same
 * way to a browser, and so are the provider sign-in pages it navigates to. A
 * second policy on top of theirs only breaks them: GitHub's sign-in page lost
 * its stylesheet that way.
 */
export function policyAppliesTo(url: string): boolean {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * The policy this app's own pages carry. They load only their bundled files
 * and talk to the main process over IPC, so nothing else is allowed.
 */
export function contentSecurityPolicy(): string {
  return (
    "default-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self'; " +
    "frame-src 'none'; " +
    "object-src 'none';"
  );
}

/**
 * What the main window does when a load fails.
 *
 * A dashboard that does not load is reported, and the window shows the status
 * page, which stays put until the user retries. Subframes and pages off the
 * dashboard, such as a provider's sign-in, are left alone. -3 is a load
 * another navigation replaced, never a failure.
 */
export function loadFailureAction(failure: {
  errorCode: number;
  isMainFrame: boolean;
  onDashboard: boolean;
}): "report" | "ignore" {
  return failure.isMainFrame && failure.errorCode !== -3 && failure.onDashboard
    ? "report"
    : "ignore";
}

async function loadStartupSurface(win: BrowserWindow, runtime: Runtime): Promise<void> {
  const startupSurface = chooseStartupSurface(runtime.getDashboardUrl(), runtime.isReady());
  if (startupSurface.kind === "onboarding") {
    await win.loadFile(ONBOARDING_HTML);
    return;
  }

  await win.loadURL(startupSurface.url);
}

export async function loadDashboard(win: BrowserWindow, url: string): Promise<void> {
  await win.loadURL(url);
}

export function shouldNavigateToDashboard(currentUrl: string, dashboardUrl: string): boolean {
  return shouldAutoOpenDashboard(currentUrl, ONBOARDING_URL, dashboardUrl);
}

export async function createMainWindow(runtime: Runtime): Promise<BrowserWindow> {
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

  const policy = contentSecurityPolicy();
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

  // Tray-resident app: closing the window only hides it, and this computer
  // stays connected as a device. The window comes back via the tray, dock, or
  // the activate handler. A real quit goes through lifecycle.requestStopAndQuit
  // which flips isQuitting() first, so the close goes through.
  win.on("close", (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    win.hide();
  });

  await loadStartupSurface(win, runtime);

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, url, isMainFrame) => {
    const action = loadFailureAction({
      errorCode,
      isMainFrame,
      onDashboard: !shouldReturnToDashboard(url, runtime.getDashboardUrl()),
    });
    if (action === "report") {
      runtime.reportLoadFailure(`${errorDescription} (${errorCode})`);
      void loadStartupSurface(win, runtime);
    }
  });

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
