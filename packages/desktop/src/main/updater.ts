import { app, BrowserWindow, dialog, ipcMain, type MessageBoxOptions } from "electron";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateDownloadedEvent,
  type UpdateInfo,
} from "electron-updater";
import { eq } from "drizzle-orm";
import { getDb } from "./db/database";
import { settings } from "./db/schema";
import { createLogger } from "./logger";
import { prepareForUpdateInstall } from "./lifecycle";

const FIRST_UPDATE_CHECK_DELAY_MS = 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000;
const AUTO_UPDATE_ENABLED_KEY = "desktop.updates.auto_enabled";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  autoUpdateEnabled: boolean;
  currentVersion: string;
  updateVersion: string | null;
  lastCheckedAt: string | null;
  message: string;
  error: string | null;
  progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  } | null;
}

const log = createLogger("updater");

class UpdateManager {
  private started = false;
  private checkTimer: NodeJS.Timeout | null = null;
  private installRequested = false;
  private status: UpdateStatus = {
    state: "idle",
    autoUpdateEnabled: true,
    currentVersion: app.getVersion(),
    updateVersion: null,
    lastCheckedAt: null,
    message: "Update checks are ready.",
    error: null,
    progress: null,
  };

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (message?: unknown) => log.info(String(message ?? "")),
      warn: (message?: unknown) => log.warn(String(message ?? "")),
      error: (message?: unknown) => log.error(String(message ?? "")),
      debug: (message?: unknown) => log.info(String(message ?? "")),
    };

    this.registerUpdaterEvents();
    this.registerIpcHandlers();
    this.refreshAutoUpdateSetting();

    this.checkTimer = setInterval(() => {
      void this.checkForUpdates("automatic");
    }, UPDATE_CHECK_INTERVAL_MS);

    setTimeout(() => {
      void this.checkForUpdates("automatic");
    }, FIRST_UPDATE_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  getStatus(): UpdateStatus {
    return { ...this.status, progress: this.status.progress ? { ...this.status.progress } : null };
  }

  async checkForUpdates(source: "manual" | "automatic" = "manual"): Promise<UpdateStatus> {
    this.refreshAutoUpdateSetting();

    if (source === "automatic" && !this.status.autoUpdateEnabled) {
      return this.getStatus();
    }

    if (this.status.state === "downloading" || this.status.state === "downloaded") {
      return this.getStatus();
    }

    if (!this.isSupportedPlatform()) {
      return this.setStatus({
        state: "not-available",
        message: "Desktop auto-update is available on macOS and Windows.",
        error: null,
        progress: null,
        lastCheckedAt: new Date().toISOString(),
      });
    }

    if (!app.isPackaged) {
      return this.setStatus({
        state: "not-available",
        message: "Update checks run in installed builds.",
        error: null,
        progress: null,
        lastCheckedAt: new Date().toISOString(),
      });
    }

    try {
      log.info(`Checking for updates (${source})`);
      this.setStatus({
        state: "checking",
        message: "Checking for updates...",
        error: null,
        progress: null,
        lastCheckedAt: new Date().toISOString(),
      });

      const result = await autoUpdater.checkForUpdates();
      if (result == null) {
        return this.setStatus({
          state: "not-available",
          message: "No update feed is available for this build.",
          error: null,
          progress: null,
        });
      }

      return this.getStatus();
    } catch (err) {
      return this.handleError(err);
    }
  }

  async runManualUpdate(): Promise<UpdateStatus> {
    if (this.status.state === "available") {
      return this.downloadUpdate();
    }

    if (this.status.state === "downloaded") {
      return this.setStatus({
        state: "downloaded",
        message: "The update is ready. Restart Rome to finish installing.",
        error: null,
      });
    }

    return this.checkForUpdates("manual");
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (this.status.state !== "available") {
      return this.setStatus({
        state: this.status.state,
        message: "No update is ready to download.",
      });
    }

    try {
      this.setStatus({
        state: "downloading",
        message: `Downloading Rome ${this.status.updateVersion ?? ""}...`.trim(),
        error: null,
        progress: null,
      });
      await autoUpdater.downloadUpdate();
      return this.getStatus();
    } catch (err) {
      return this.handleError(err);
    }
  }

  async installUpdate(): Promise<UpdateStatus> {
    // The state check alone does not make this idempotent: the first call
    // leaves the state at "downloaded", so a second would reach
    // quitAndInstall again. There are two ways in now — the automatic prompt
    // and the menu's — and both can be on screen for one download.
    if (this.installRequested) {
      return this.getStatus();
    }

    if (this.status.state !== "downloaded") {
      return this.setStatus({
        state: this.status.state,
        message: "No downloaded update is ready to install.",
      });
    }

    this.installRequested = true;
    this.setStatus({
      state: "downloaded",
      message: "Preparing to restart and install the update...",
      error: null,
    });
    await prepareForUpdateInstall();
    autoUpdater.quitAndInstall(false, true);
    return this.getStatus();
  }

  private registerUpdaterEvents(): void {
    autoUpdater.on("checking-for-update", () => {
      this.setStatus({
        state: "checking",
        message: "Checking for updates...",
        error: null,
        progress: null,
        lastCheckedAt: new Date().toISOString(),
      });
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      log.info(`Update available: ${info.version}`);
      this.setStatus({
        state: "available",
        updateVersion: info.version,
        message: `Rome ${info.version} is available.`,
        error: null,
        progress: null,
      });
      void this.downloadUpdate();
    });

    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      log.info(`No update available: latest=${info.version}`);
      this.setStatus({
        state: "not-available",
        updateVersion: info.version,
        message: "Rome is up to date.",
        error: null,
        progress: null,
        lastCheckedAt: new Date().toISOString(),
      });
    });

    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.setStatus({
        state: "downloading",
        message: `Downloading update (${Math.round(progress.percent)}%).`,
        error: null,
        progress: {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        },
      });
    });

    autoUpdater.on("update-downloaded", (event: UpdateDownloadedEvent) => {
      log.info(`Update downloaded: ${event.version}`);
      this.setStatus({
        state: "downloaded",
        updateVersion: event.version,
        message: `Rome ${event.version} is ready to install.`,
        error: null,
        progress: null,
      });
      this.promptToInstall();
    });

    autoUpdater.on("error", (err: Error) => {
      void this.handleError(err);
    });
  }

  private registerIpcHandlers(): void {
    ipcMain.handle("updater:getStatus", () => this.getStatus());
    ipcMain.handle("updater:check", () => this.runManualUpdate());
    ipcMain.handle("updater:download", () => this.downloadUpdate());
    ipcMain.handle("updater:install", () => this.installUpdate());
    ipcMain.handle("updater:setAutoUpdateEnabled", (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      this.setAutoUpdateEnabled(enabled);
      if (enabled) {
        void this.checkForUpdates("automatic");
      }
      return this.getStatus();
    });
  }

  private promptToInstall(): void {
    const options: MessageBoxOptions = {
      type: "info",
      title: "Update Ready",
      message: "The update is ready to install.",
      detail: "Restart Rome now to finish installing, or install it the next time you quit.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    };
    void this.showDialog(options).then(({ response }) => {
      if (response === 0 && !this.installRequested) {
        void this.installUpdate();
      }
    });
  }

  /**
   * Visible, or nothing. A sheet is attached to a window, and this app hides
   * its windows rather than closing them — so "a window exists" is a poor
   * proxy for "the user can see the sheet". Falling through to a windowless
   * dialog is the honest answer when everything is in the tray.
   */
  private getDialogWindow(): BrowserWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed() && focused.isVisible()) {
      return focused;
    }
    return BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
  }

  private showDialog(options: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const window = this.getDialogWindow();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }

  /** The menu's "Check for Updates…" reporting what a manual check found. */
  showStatusDialog(options: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    return this.showDialog(options);
  }

  private refreshAutoUpdateSetting(): boolean {
    try {
      const row = getDb()
        .select()
        .from(settings)
        .where(eq(settings.key, AUTO_UPDATE_ENABLED_KEY))
        .get();
      const enabled = row?.value == null ? true : row.value !== "false";
      this.status = {
        ...this.status,
        autoUpdateEnabled: enabled,
      };
      return enabled;
    } catch (err) {
      log.warn(`Failed to read auto-update setting; defaulting on (${String(err)})`);
      this.status = {
        ...this.status,
        autoUpdateEnabled: true,
      };
      return true;
    }
  }

  private setAutoUpdateEnabled(enabled: boolean): void {
    const now = new Date().toISOString();
    getDb()
      .insert(settings)
      .values({
        key: AUTO_UPDATE_ENABLED_KEY,
        value: enabled ? "true" : "false",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: enabled ? "true" : "false", updatedAt: now },
      })
      .run();

    this.setStatus({
      autoUpdateEnabled: enabled,
      message: enabled ? "Automatic updates are on." : "Automatic updates are off.",
      error: null,
    });
  }

  private handleError(err: unknown): UpdateStatus {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Updater error", err);
    return this.setStatus({
      state: "error",
      message: "Update check failed. Rome will try again later.",
      error: message,
      progress: null,
    });
  }

  private setStatus(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = {
      ...this.status,
      ...patch,
      currentVersion: app.getVersion(),
    };
    this.broadcastStatus();
    return this.getStatus();
  }

  private broadcastStatus(): void {
    const status = this.getStatus();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("updater:status", status);
      }
    }
  }

  private isSupportedPlatform(): boolean {
    return process.platform === "darwin" || process.platform === "win32";
  }
}

export const updateManager = new UpdateManager();

export function setupUpdater(): void {
  updateManager.start();
}
