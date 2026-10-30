import { app, type BrowserWindow } from "electron";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("protocol");

const SCHEME = "rome";

export interface ProtocolHandlerDeps {
  ensureMainWindow: () => Promise<BrowserWindow>;
  getDashboardUrl: () => string;
  // Resolves once the Rome the app opens is reachable. handleRomeUrl awaits this
  // before navigating so cold-start deep links don't race the dashboard
  // startup (loadURL would otherwise fail and the retry path falls back to
  // the default startup surface, dropping the deep link).
  waitForRuntime: () => Promise<void>;
}

// Register before app.ready so the OS knows we handle rome:// links even
// for cold-start launches. In dev (Electron loaded by node), pass the
// script path explicitly per Electron docs; in a packaged build the default
// form is correct.
export function registerProtocolClient(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(SCHEME);
  }
}

// macOS delivers rome:// URLs via the `open-url` event, which can fire
// before the first window exists when launched cold. We queue any URL
// received before the handler is wired up.
let pendingDeepLink: string | null = null;
let deps: ProtocolHandlerDeps | null = null;

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (deps) {
    void handleRomeUrl(url);
  } else {
    pendingDeepLink = url;
  }
});

export function setupProtocolHandler(handlers: ProtocolHandlerDeps): void {
  deps = handlers;
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    void handleRomeUrl(url);
  }
}

// Windows/Linux deliver the URL as an extra argv entry on second-instance.
export function consumeProtocolFromArgv(argv: readonly string[]): void {
  const url = argv.find((arg) => arg.startsWith(`${SCHEME}://`));
  if (url) void handleRomeUrl(url);
}

async function handleRomeUrl(rawUrl: string): Promise<void> {
  if (!deps) {
    pendingDeepLink = rawUrl;
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    log.warn(`ignoring malformed rome:// URL: ${rawUrl}`);
    return;
  }
  if (parsed.protocol !== `${SCHEME}:`) return;

  // We currently only know one verb. Easy to extend by branching on host.
  if (parsed.host !== "install") {
    log.warn(`unsupported rome:// host: ${parsed.host}`);
    return;
  }
  const listingPath = parsed.pathname.replace(/^\/+/, "");
  if (!listingPath) {
    log.warn(`rome://install URL missing listing id: ${rawUrl}`);
    return;
  }

  // Wait for the dashboard to be reachable before resolving its address.
  // On cold start, the Rome may still be connecting — loadURL would fail and
  // the window's did-fail-load handler falls back to the startup surface,
  // dropping the deep link. The dashboard runs its own connect gate, so an
  // un-enrolled instance lands there first and resumes here after enrolling.
  try {
    await deps.waitForRuntime();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`runtime never became ready for deep link: ${rawUrl} (${message})`);
    // Surface the window anyway. This app lives in the tray with its window
    // hidden, so returning silently means the click produced nothing the user
    // can see. A window created here lands on onboarding, which carries the
    // failure detail and a retry; an existing window is shown as-is, so one
    // already sitting on a dead dashboard stays there. Reloading that case
    // needs a reload dep this handler does not have.
    const failedWin = await deps.ensureMainWindow();
    if (failedWin.isMinimized()) failedWin.restore();
    if (!failedWin.isVisible()) failedWin.show();
    failedWin.focus();
    return;
  }

  // Read the origin only after that wait. getDashboardUrl() is a port-80
  // placeholder until the loopback proxy exists, so resolving it earlier bakes
  // a dead address into `target` even when the runtime comes up correctly.
  const dashboardUrl = deps.getDashboardUrl();
  let target: URL;
  try {
    target = new URL(`/install-app/${listingPath}`, dashboardUrl);
  } catch {
    log.warn(`could not build install URL from dashboard=${dashboardUrl} path=${listingPath}`);
    return;
  }

  // Path-traversal guard: URL normalization eats ../, %2e%2e%2f, and other
  // encoded escapes — so checking the final pathname is a reliable backstop
  // regardless of what shape of listing id we accept. A crafted
  // rome://install/../../settings would otherwise resolve to /settings on
  // the local dashboard.
  if (!target.pathname.startsWith("/install-app/") || target.pathname === "/install-app/") {
    log.warn(`rome://install path traversal or empty listing blocked: ${rawUrl}`);
    return;
  }
  for (const [k, v] of parsed.searchParams.entries()) {
    target.searchParams.set(k, v);
  }

  const win = await deps.ensureMainWindow();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();

  try {
    await win.loadURL(target.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`failed to navigate to install confirmation: ${target.toString()} (${message})`);
  }
}
