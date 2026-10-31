import { release } from "os";
import { app, BrowserWindow, dialog, net, powerSaveBlocker, shell } from "electron";
import { initDatabase } from "./db/database";
import { createLogger, LOG_FILE } from "./logger";
import {
  createMainWindow,
  createSettingsWindow,
  loadDashboard,
  shouldNavigateToDashboard,
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
import type { RuntimeStatus } from "./runtime/provider";
import { RuntimeController } from "./runtime/controller";
import { RemoteRuntime } from "./runtime/remote";
import { DEV_DASHBOARD_URL_ENV, DevUrlRuntime, resolveDevDashboardUrl } from "./runtime/dev-url";
import type { Runtime } from "./runtime/runtime";
import { createCloudAccount, deviceName } from "./cloud/electron";
import { DeviceHost, type DeviceStatus } from "./cloud/device-host";
import { adoptLoginShellPath } from "./cloud/login-path";
import { KeepAwake } from "./keep-awake";
import { consumeProtocolFromArgv, registerProtocolClient, setupProtocolHandler } from "./protocol";

const log = createLogger("main");

let mainWindow: BrowserWindow | null = null;
// Chosen in bootstrap, once the settings database says which Rome this launch
// opens.
let runtime: Runtime;

const netFetch: typeof fetch = (input, init) =>
  net.fetch(input instanceof URL ? input.toString() : input, init);

async function openDebugLog(): Promise<void> {
  const error = await shell.openPath(LOG_FILE);
  if (error) throw new Error(error);
}

async function bootstrap() {
  try {
    log.info("Bootstrap starting...");

    initDatabase();
    log.info("Database initialized");

    // A staging override that is not an exact https origin throws here, and
    // with no Rome Cloud there is nothing this app can open.
    const cloudAccount = createCloudAccount();
    const devDashboardUrl = resolveDevDashboardUrl(
      app.isPackaged,
      process.env[DEV_DASHBOARD_URL_ENV],
    );
    const controller = new RuntimeController({
      cloudAccount,
      savedTarget: readRuntimeTarget(),
      writeTarget: writeRuntimeTarget,
      createRemote: (instance, onSelect) =>
        new RemoteRuntime(instance, {
          account: cloudAccount,
          fetchImpl: netFetch,
          openLogs: openDebugLog,
          openCloud: () =>
            shell.openExternal(new URL("/dashboard", cloudAccount.cloudOrigin).toString()),
          onSelect,
        }),
      relaunch: () => {
        app.relaunch();
        requestStopAndQuit();
      },
      override: devDashboardUrl
        ? new DevUrlRuntime(devDashboardUrl, { openLogs: openDebugLog })
        : null,
    });
    runtime = controller.runtime;
    const keepAwake = new KeepAwake(powerSaveBlocker);
    // The credential file is shared by every build on this computer, so a dev
    // window would connect as the same device and take over its connection.
    const deviceHost = !devDashboardUrl
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
            keepAwake.sync(status);
            // Only the app's own pages and the open Rome hear it, as with device:get.
            const origin = controller.activeTarget().instance?.origin;
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
    // A dev window opened through DEV_DASHBOARD_URL_ENV never connects this
    // computer; every other launch does once it is signed in.
    const device = {
      status: (): DeviceStatus => deviceHost?.status() ?? { state: "off" },
      start: async () => {
        await deviceHost?.start();
      },
      stop: async () => {
        await deviceHost?.stop();
        keepAwake.release();
      },
      setEnabled: async (enabled: boolean) => {
        writeDeviceEnabled(enabled);
        await deviceHost?.stop();
        await device.start();
      },
    };
    const active = controller.activeTarget();
    log.info(
      devDashboardUrl
        ? `Opening ${devDashboardUrl} from ${DEV_DASHBOARD_URL_ENV}`
        : `Opening Rome Cloud${active.instance ? ` (${active.instance.origin})` : ""}`,
    );

    registerIpcHandlers(controller, {
      openSettingsWindow: () => createSettingsWindow(),
      cloudAccount,
      device,
    });

    mainWindow = await createMainWindow(runtime);
    log.info("Main window created");

    setupProtocolHandler({
      ensureMainWindow: async () => {
        if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
        mainWindow = await createMainWindow(runtime);
        return mainWindow;
      },
      getDashboardUrl: () => runtime.getDashboardUrl(),
      // A deep link only needs the Rome reachable right now. isReady() would
      // trust a cached phase and navigate into an error page if the instance
      // went down since; isServing() checks for real. On a miss, recover — then check
      // again, because ensureReady() swallows its own failures (it sets a
      // "failed" phase and resolves), so returning after it would let the
      // caller navigate into the very dead end this guards against.
      waitForRuntime: async () => {
        if (await runtime.isServing()) return;
        await runtime.ensureReady();
        if (!(await runtime.isServing())) {
          throw new Error("Your Rome did not become reachable.");
        }
      },
    });

    // Windows/Linux cold-start: when the user clicks rome://… while Rome
    // isn't running, the OS launches us with the URL in process.argv (no
    // open-url event, no second-instance event). macOS uses open-url
    // instead and leaves argv clean, so this call is a no-op there.
    consumeProtocolFromArgv(process.argv);

    runtime.on("status", (status: RuntimeStatus) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send("runtime:status", status);
        }
      }

      if (status.phase === "ready" && mainWindow && !mainWindow.isDestroyed()) {
        const currentUrl = mainWindow.webContents.getURL();
        if (shouldNavigateToDashboard(currentUrl, runtime.getDashboardUrl())) {
          void loadDashboard(mainWindow, runtime.getDashboardUrl());
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
        if (!runtime.isReady()) return;
        const dashboardUrl = runtime.getDashboardUrl();
        if (shouldReturnToDashboard(mainWindow.webContents.getURL(), dashboardUrl)) {
          void loadDashboard(mainWindow, dashboardUrl);
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
      mainWindow = await createMainWindow(runtime);
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
        })
      : null;

    setupTray({
      getMainWindow: () => mainWindow,
      ensureMainWindow: async () => {
        if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
        mainWindow = await createMainWindow(runtime);
        return mainWindow;
      },
      openSettings: () => {
        createSettingsWindow();
      },
      runtime,
      floatingPill,
    });
    setupUpdater();
    // The Rome keeps running in Rome Cloud; quitting only disconnects this
    // computer.
    setupLifecycle({
      onShutdown: async () => {
        runtime.dispose?.();
        await device.stop();
      },
    });

    // Enrollment is owned by the dashboard, so desktop startup never waits for
    // an instance token.
    void runtime.ensureReady();
    void device.start();

    log.info("Bootstrap complete");
  } catch (err) {
    log.error("Bootstrap failed", err);
    dialog.showErrorBox("Rome can't start", err instanceof Error ? err.message : String(err));
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
    if (isQuitting() || !runtime) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      return;
    }
    void createMainWindow(runtime).then((win) => {
      mainWindow = win;
    });
  });
}
