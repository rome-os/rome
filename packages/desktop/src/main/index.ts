import { app, BrowserWindow } from "electron";
import { initDatabase } from "./db/database";
import { createLogger } from "./logger";
import {
  createMainWindow,
  createQuittingWindow,
  createSettingsWindow,
  loadLocalDashboard,
  shouldNavigateToLocalDashboard,
} from "./window";
import { registerIpcHandlers } from "./ipc";
import { isQuitting, setupLifecycle } from "./lifecycle";
import { setupUpdater, updateManager } from "./updater";
import { RESTART_BUTTON, updateDialogFor } from "./update-dialog";
import { setupTray } from "./tray";
import { setupApplicationMenu } from "./menu";
import { shouldReturnToDashboard } from "./startup-surface";
import { RuntimeManager, type RuntimeStatus } from "./runtime/manager";
import { createRomeImageUpdater } from "./runtime/image-updater";
import { consumeProtocolFromArgv, registerProtocolClient, setupProtocolHandler } from "./protocol";

const log = createLogger("main");

let mainWindow: BrowserWindow | null = null;
let quittingWindow: BrowserWindow | null = null;
const runtimeManager = new RuntimeManager();
const romeImageUpdater = createRomeImageUpdater(runtimeManager);

async function bootstrap() {
  try {
    log.info("Bootstrap starting...");

    initDatabase();
    log.info("Database initialized");

    registerIpcHandlers(runtimeManager, {
      openSettingsWindow: () => createSettingsWindow(),
    });

    mainWindow = await createMainWindow(runtimeManager);
    log.info("Main window created");

    setupProtocolHandler({
      ensureMainWindow: async () => {
        if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
        mainWindow = await createMainWindow(runtimeManager);
        return mainWindow;
      },
      getDashboardUrl: () => runtimeManager.getDashboardUrl(),
      // A deep link only needs the runtime reachable right now. isReady() would
      // trust a cached phase and navigate into a 502 if the container died
      // since; isServing() checks for real. On a miss, recover — then check
      // again, because ensureReady() swallows its own failures (it sets a
      // "failed" phase and resolves), so returning after it would let the
      // caller navigate into the very dead end this guards against.
      waitForRuntime: async () => {
        if (await runtimeManager.isServing()) return;
        await runtimeManager.ensureReady();
        if (!(await runtimeManager.isServing())) {
          throw new Error("The local Rome runtime did not become reachable.");
        }
      },
    });

    // Windows/Linux cold-start: when the user clicks rome://… while Rome
    // isn't running, the OS launches us with the URL in process.argv (no
    // open-url event, no second-instance event). macOS uses open-url
    // instead and leaves argv clean, so this call is a no-op there.
    consumeProtocolFromArgv(process.argv);

    runtimeManager.on("status", (status: RuntimeStatus) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send("runtime:status", status);
        }
      }

      if (status.phase === "ready" && mainWindow && !mainWindow.isDestroyed()) {
        const currentUrl = mainWindow.webContents.getURL();
        if (shouldNavigateToLocalDashboard(currentUrl, runtimeManager.getDashboardUrl())) {
          void loadLocalDashboard(mainWindow, runtimeManager.getDashboardUrl());
        }
      }
    });

    setupApplicationMenu(
      () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.show();
        mainWindow.focus();
        // Before ready the dashboard URL is a placeholder and the window is on
        // onboarding, so raising it is the whole job.
        if (!runtimeManager.isReady()) return;
        const dashboardUrl = runtimeManager.getDashboardUrl();
        if (shouldReturnToDashboard(mainWindow.webContents.getURL(), dashboardUrl)) {
          void loadLocalDashboard(mainWindow, dashboardUrl);
        }
      },
      () => createSettingsWindow(),
      // The check only broadcasts a status, which nothing renders unless the
      // settings window happens to be open — so from a menu the common
      // "already up to date" answer arrived as silence.
      async () => {
        const status = await updateManager.checkForUpdates("manual");
        const { response } = await updateManager.showStatusDialog(updateDialogFor(status));
        if (status.state === "downloaded" && response === RESTART_BUTTON) {
          await updateManager.installUpdate();
        }
      },
    );
    setupTray({
      getMainWindow: () => mainWindow,
      ensureMainWindow: async () => {
        if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
        mainWindow = await createMainWindow(runtimeManager);
        return mainWindow;
      },
      openSettings: () => {
        createSettingsWindow();
      },
      runtimeManager,
    });
    setupUpdater();
    romeImageUpdater.start();
    setupLifecycle({
      runtimeManager,
      onShutdownStart: () => {
        if (quittingWindow && !quittingWindow.isDestroyed()) return;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && win.isVisible()) win.hide();
        }
        quittingWindow = createQuittingWindow();
      },
    });

    // Enrollment is owned by the dashboard, so desktop startup never waits for
    // an instance token.
    void runtimeManager.ensureReady();

    log.info("Bootstrap complete");
  } catch (err) {
    log.error("Bootstrap failed", err);
    app.quit();
  }
}

registerProtocolClient();

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (isQuitting()) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    // Windows/Linux: rome:// URLs arrive as an extra argv entry on the
    // second-instance launch (the OS routes the link to us, and we forward
    // it to the already-running primary instance).
    consumeProtocolFromArgv(argv);
  });

  app.on("ready", bootstrap);

  app.on("before-quit", () => {
    updateManager.stop();
    romeImageUpdater.stop();
  });

  app.on("window-all-closed", () => {
    // macOS keeps the app alive in the tray.
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    // After hide-to-tray the window still exists (just hidden), so the
    // "no windows" check alone would leave Dock-click / relaunch dead
    // until the user finds the tray.
    if (isQuitting()) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      return;
    }
    void createMainWindow(runtimeManager).then((win) => {
      mainWindow = win;
    });
  });
}
