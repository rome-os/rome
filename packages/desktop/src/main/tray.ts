import { existsSync } from "fs";
import { join } from "path";
import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import { createLogger } from "./logger";
import { isQuitting, requestStopAndQuit } from "./lifecycle";
import type { RuntimeManager, RuntimeStatus } from "./runtime/manager";

const log = createLogger("tray");

let tray: Tray | null = null;

/**
 * Resolve the path to the prebuilt tray template icon.
 *
 * Packaged: Rome.app/Contents/Resources/tray/trayTemplate.png
 * Dev: packages/desktop/build/tray/trayTemplate.png (one or two parents up
 * depending on whether we're running from dist/main or src/main).
 *
 * The "Template" suffix is meaningful to macOS — `setTemplateImage(true)`
 * tells AppKit to recolor the icon to match the menubar's appearance, so
 * the source PNG should be pure black on transparent.
 */
function resolveTrayIcon(): Electron.NativeImage {
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "tray", "trayTemplate.png"));
  }
  candidates.push(join(__dirname, "..", "..", "..", "build", "tray", "trayTemplate.png"));
  candidates.push(join(__dirname, "..", "..", "build", "tray", "trayTemplate.png"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) {
        if (process.platform === "darwin") img.setTemplateImage(true);
        return img;
      }
    }
  }

  log.warn("Tray icon not found on disk; falling back to inline placeholder");
  // Inline 16×16 transparent PNG so a missing build artifact never crashes
  // app startup. Surfaces as a blank menubar slot until build/tray/* is
  // populated.
  const fallback = nativeImage.createFromBuffer(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJElEQVQ4T2P8z8BQz0BAwMBIQJ2BYcANGDVg1IBRA0YNIDoaAABcpAIRwXjhOAAAAABJRU5ErkJggg==",
      "base64",
    ),
    { width: 16, height: 16 },
  );
  if (process.platform === "darwin") fallback.setTemplateImage(true);
  return fallback;
}

function statusLabel(status: RuntimeStatus | null): string {
  if (!status) return "Status: Starting…";
  switch (status.phase) {
    case "ready":
      return "Status: Ready";
    case "checking_host":
      return "Status: Checking…";
    case "installing_runtime":
      return "Status: Install required";
    case "starting_runtime":
      return "Status: Starting runtime…";
    case "pulling_image":
      return "Status: Downloading Rome…";
    case "starting_rome":
      return "Status: Starting Rome…";
    case "waiting_for_health":
      return "Status: Finishing setup…";
    case "stopping":
      return "Status: Stopping…";
    case "failed":
      return `Status: Failed${status.lastError ? ` — ${status.lastError}` : ""}`;
    default:
      return "Status: …";
  }
}

export interface SetupTrayOptions {
  getMainWindow: () => BrowserWindow | null;
  ensureMainWindow: () => Promise<BrowserWindow> | BrowserWindow;
  openSettings: () => void;
  runtimeManager: RuntimeManager;
}

export function setupTray(options: SetupTrayOptions): Tray {
  const { getMainWindow, ensureMainWindow, openSettings, runtimeManager } = options;

  tray = new Tray(resolveTrayIcon());
  tray.setToolTip("Rome");

  const showWindow = async (): Promise<void> => {
    if (isQuitting()) return;
    const existing = getMainWindow();
    if (existing && !existing.isDestroyed()) {
      if (!existing.isVisible()) existing.show();
      existing.focus();
      return;
    }
    await ensureMainWindow();
  };

  const rebuildMenu = (status: RuntimeStatus | null): void => {
    if (!tray) return;

    const stopping = isQuitting() || status?.phase === "stopping";
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "Show Rome",
        click: () => {
          void showWindow();
        },
      },
      { type: "separator" },
      {
        label: stopping ? "Status: Stopping…" : statusLabel(status),
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Settings…",
        click: openSettings,
      },
      { type: "separator" },
      {
        // No accelerator: tray menus cannot register shortcuts of their own,
        // so one printed here only advertises a key. ⌘⇧Q used to be that key
        // and no longer exists — the app menu's ⌘Q is the one quit, and it
        // stops the agent on its way out.
        label: stopping ? "Stopping agent…" : "Stop agent and quit",
        enabled: !stopping,
        click: () => {
          if (tray) {
            tray.setToolTip("Rome: stopping…");
          }
          requestStopAndQuit();
        },
      },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  rebuildMenu(runtimeManager.getStatus());
  runtimeManager.on("status", (status: RuntimeStatus) => rebuildMenu(status));

  tray.on("click", () => {
    void showWindow();
  });

  // Prevent the tray icon from being garbage-collected if the wrapping
  // closure ever loses its only reference.
  app.on("before-quit", () => {
    if (tray) {
      try {
        tray.destroy();
      } catch {
        // Already destroyed.
      }
      tray = null;
    }
  });

  return tray;
}
