import { release } from "os";
import { existsSync } from "fs";
import { app, BrowserWindow, net, shell } from "electron";
import { initDatabase } from "./db/database";
import { createLogger } from "./logger";
import {
  createMainWindow,
  createQuittingWindow,
  createSettingsWindow,
  loadLocalDashboard,
  shouldNavigateToLocalDashboard,
} from "./window";
import {
  readDeviceEnabled,
  readRuntimeTarget,
  registerIpcHandlers,
  writeDeviceEnabled,
  writeRuntimeTarget,
} from "./ipc";
import { isQuitting, requestStopAndQuit, setupLifecycle } from "./lifecycle";
import { setupUpdater, updateManager } from "./updater";
import { RESTART_BUTTON, updateDialogFor } from "./update-dialog";
import { setupTray } from "./tray";
import { setupFloatingPill } from "./floating-pill";
import { supportsFloatingPill } from "./floating-pill-state";
import { setupApplicationMenu } from "./menu";
import { shouldReturnToDashboard } from "./startup-surface";
import { RuntimeManager, type RuntimeStatus } from "./runtime/manager";
import { createRomeImageUpdater, type RomeImageUpdater } from "./runtime/image-updater";
import { resolveRuntimePaths } from "./runtime/config";
import { RuntimeController } from "./runtime/controller";
import { RemoteRuntime } from "./runtime/remote";
import type { Runtime } from "./runtime/runtime";
import type { CloudAccount } from "./cloud/account";
import { createCloudAccount, deviceName } from "./cloud/electron";
import { DeviceHost, type DeviceStatus } from "./cloud/device-host";
import { adoptLoginShellPath } from "./cloud/login-path";
import { consumeProtocolFromArgv, registerProtocolClient, setupProtocolHandler } from "./protocol";

const log = createLogger("main");

let mainWindow: BrowserWindow | null = null;
let quittingWindow: BrowserWindow | null = null;
// Chosen in bootstrap, once the settings database says which Rome this launch
// opens. The image updater exists only while the private VM is the one open.
let runtimeManager: Runtime;
let romeImageUpdater: RomeImageUpdater | null = null;

function createCloudAccountOrNull(): CloudAccount | null {
  try {
    return createCloudAccount();
  } catch (err) {
    // A staging override that is not an exact https origin cannot back a
    // sign-in; the local VM still works without one.
    log.warn(`Rome Cloud sign-in is unavailable (${String(err)})`);
    return null;
  }
}

const netFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.toString() : input, init);

async function openDebugLog(): Promise<void> {
  const error = await shell.openPath(resolveRuntimePaths().debugLogFile);
  if (error) throw new Error(error);
}

// An install from before Rome Cloud mode keeps its Rome in this directory.
function hasLocalRuntime(): boolean {
  return existsSync(resolveRuntimePaths().rootDir);
}

function createLocalRuntime(): Runtime {
  const local = new RuntimeManager();
  romeImageUpdater = createRomeImageUpdater(local);
  romeImageUpdater.start();
  return local;
}

async function bootstrap() {
  try {
    log.info("Bootstrap starting...");

    initDatabase();
    log.info("Database initialized");

    const cloudAccount = createCloudAccountOrNull();
    const controller = new RuntimeController({
      cloudAccount,
      savedTarget: readRuntimeTarget(hasLocalRuntime()),
      writeTarget: writeRuntimeTarget,
      createLocal: createLocalRuntime,
      createRemote: (instance, onSelect) => {
        if (!cloudAccount) throw new Error("This build cannot sign in to Rome Cloud.");
        return new RemoteRuntime(instance, {
          account: cloudAccount,
          fetchImpl: netFetch,
          openLogs: openDebugLog,
          openCloud: () =>
            shell.openExternal(new URL("/dashboard", cloudAccount.cloudOrigin).toString()),
          onSelect,
        });
      },
      relaunch: () => {
        app.relaunch();
        requestStopAndQuit();
      },
    });
    runtimeManager = controller.runtime;
    const deviceHost = cloudAccount
      ? new DeviceHost({
          cloudOrigin: cloudAccount.cloudOrigin,
          deviceName: deviceName(),
          credential: () => cloudAccount.credential(),
          enabled: readDeviceEnabled,
          onRevoked: async () => {
            await controller.signOut();
          },
          prepare: process.platform === "darwin" ? adoptLoginShellPath : undefined,
          onStatus: (status) => {
            // Only the app's own pages and the open Rome hear it, as with device:get.
            const target = controller.activeTarget();
            const origin = target.kind === "remote" ? target.instance?.origin : null;
            for (const window of BrowserWindow.getAllWindows()) {
              if (window.isDestroyed()) continue;
              const url = window.webContents.getURL();
              if (url.startsWith("file:") || (origin && url.startsWith(`${origin}/`))) {
                window.webContents.send("device:status", status);
              }
            }
          },
        })
      : null;
    // Only a Rome Cloud launch connects this computer. Switching to the VM
    // restarts the app, so a VM launch never connects it or changes its PATH.
    const device = {
      status: (): DeviceStatus => deviceHost?.status() ?? { state: "off" },
      start: async () => {
        if (controller.activeTarget().kind === "remote") await deviceHost?.start();
      },
      stop: async () => {
        await deviceHost?.stop();
      },
      setEnabled: async (enabled: boolean) => {
        writeDeviceEnabled(enabled);
        await deviceHost?.stop();
        await device.start();
      },
    };
    const active = controller.activeTarget();
    log.info(
      active.kind === "remote"
        ? `Opening Rome Cloud${active.instance ? ` (${active.instance.origin})` : ""}`
        : "Opening the Rome on this computer",
    );

    registerIpcHandlers(controller, {
      openSettingsWindow: () => createSettingsWindow(),
      cloudAccount,
      hasLocalRuntime,
      device,
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
    const showMainWindow = async (): Promise<void> => {
      if (isQuitting()) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        // show() even when already visible: it activates the app outright,
        // where focus() alone only asks politely and can leave the window
        // behind the app the user clicked from.
        mainWindow.show();
        mainWindow.focus();
        return;
      }
      mainWindow = await createMainWindow(runtimeManager);
    };

    // macOS only, and not yet macOS 27: the panel window type is what makes the
    // pill unobtrusive, and it is AppKit's.
    const pillSupported = supportsFloatingPill(process.platform, release());
    // Without this line an icon that is off on purpose reads, in a log bundle,
    // the same as one that failed to open.
    if (!pillSupported) log.info(`Floating icon is off on ${process.platform} ${release()}`);
    const floatingPill = pillSupported
      ? setupFloatingPill({
          showMainWindow,
          openSettings: () => {
            createSettingsWindow();
          },
          runtimeManager,
        })
      : null;

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
      floatingPill,
    });
    setupUpdater();
    setupLifecycle({
      runtimeManager,
      onShutdownStart: () => {
        void device.stop();
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
    void device.start();

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
    romeImageUpdater?.stop();
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
    if (isQuitting() || !runtimeManager) return;
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
