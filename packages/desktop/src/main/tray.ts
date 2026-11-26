import { existsSync } from "fs";
import { join } from "path";
import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import type { FloatingPill } from "./floating-pill";
import type { ShareShortcut } from "./share-shortcut";
import { SHARE_SHORTCUT_LABEL } from "./share-shortcut/state";
import { createLogger } from "./logger";
import { isQuitting, requestStopAndQuit } from "./lifecycle";
import type { DeviceStatus } from "./cloud/device-host";
import type { ComputerUsePane, createComputerUseSettings } from "./computer-use-settings";
import type { RuntimeStatus } from "./runtime/provider";
import type { Runtime } from "./runtime/runtime";

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

export function statusLabel(status: RuntimeStatus | null): string {
  if (!status) return "Status: Starting…";
  switch (status.phase) {
    case "ready":
      return "Status: Ready";
    case "waiting_for_user":
      return status.primaryAction === "sign_in"
        ? "Status: Not signed in"
        : "Status: Waiting for you";
    case "failed":
      return `Status: Failed${status.lastError ? ` — ${status.lastError}` : ""}`;
    default:
      return "Status: Connecting…";
  }
}

/**
 * The line for this computer shows its connection. Include Computer use when off if it has no
 * submenu. The runtime status already says when the app is signed out.
 */
export function deviceLabel(device: DeviceStatus, showComputerUse = true): string | null {
  if (device.state === "off") return null;
  const connection = { connected: "Connected", connecting: "Connecting…", offline: "Offline" }[
    device.connection
  ];
  return `This Mac: ${connection}${showComputerUse && !device.computerUse ? " · Computer use off" : ""}`;
}

/** The tray's lines for the share shortcut: none until an app is chosen for it. */
export function shareShortcutItems(
  shareShortcut: Pick<ShareShortcut, "current" | "open" | "clear"> | null,
): Electron.MenuItemConstructorOptions[] {
  const target = shareShortcut?.current();
  if (!shareShortcut || !target) return [];
  return [
    {
      label: `${SHARE_SHORTCUT_LABEL} Opens ${target.name}`,
      submenu: [
        { label: `Open ${target.name}`, click: () => shareShortcut.open() },
        { label: `Turn Off ${SHARE_SHORTCUT_LABEL}`, click: () => shareShortcut.clear() },
      ],
    },
  ];
}

export interface SetupTrayOptions {
  getMainWindow: () => BrowserWindow | null;
  ensureMainWindow: () => Promise<BrowserWindow> | BrowserWindow;
  openSettings: () => void;
  /** Opens this computer's local audit log. Omitted, the menu has no such item. */
  openAuditLog?: () => void;
  runtime: Runtime;
  /** Null where the pill does not exist (every platform but macOS). */
  floatingPill: FloatingPill | null;
  /** The key that sends the selection to an app. Omitted or null off macOS. */
  shareShortcut?: ShareShortcut | null;
  /** This computer as a device. Without it the menu has no line for it. */
  device?: { status(): DeviceStatus; onChange(listener: () => void): void };
  computerUseSettings?: ReturnType<typeof createComputerUseSettings>;
}

export function setupTray(options: SetupTrayOptions): Tray {
  const {
    getMainWindow,
    ensureMainWindow,
    openSettings,
    openAuditLog,
    runtime,
    floatingPill,
    shareShortcut,
    device,
    computerUseSettings,
  } = options;

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

    const quitting = isQuitting();
    const computerUse = computerUseSettings?.status();
    const deviceLine = device ? deviceLabel(device.status(), !computerUse) : null;
    const openPrivacyPane = (pane: ComputerUsePane) => {
      void computerUseSettings?.open(pane).catch((error) => {
        log.warn(`Could not open macOS privacy settings (${String(error)})`);
      });
    };
    const setupPermissions = () => {
      void computerUseSettings?.setup().catch((error) => {
        log.warn(`Could not open the Computer Use permission guide (${String(error)})`);
      });
    };
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "Show Rome",
        click: () => {
          void showWindow();
        },
      },
      { type: "separator" },
      {
        label: quitting ? "Status: Quitting…" : statusLabel(status),
        enabled: false,
      },
      ...(deviceLine ? [{ label: deviceLine, enabled: false }] : []),
      { type: "separator" },
      {
        label: "Settings…",
        click: openSettings,
      },
      ...(openAuditLog ? [{ label: "Computer Use Log…", click: openAuditLog }] : []),
      ...(computerUse
        ? [
            {
              label: `Computer Use: ${computerUse.enabled ? "On" : "Off"}`,
              submenu: [
                ...(computerUse.helperPresent
                  ? [{ label: "Set Up Permissions…", click: setupPermissions }]
                  : []),
                {
                  label: `Bundled helper: ${computerUse.helperPresent ? "Installed" : "Missing"}`,
                  enabled: false,
                },
                { label: "Accessibility Settings…", click: () => openPrivacyPane("accessibility") },
                {
                  label: "Screen Recording Settings…",
                  click: () => openPrivacyPane("screenRecording"),
                },
                ...(computerUse.helperPresent
                  ? [
                      {
                        label: "Show Rome Computer Use in Finder",
                        click: computerUseSettings?.revealHelper,
                      },
                    ]
                  : []),
              ],
            },
          ]
        : []),
      // The floating icon is off until it is ticked here, and this is the way
      // back after its own menu has hidden it.
      ...(floatingPill
        ? [
            {
              label: "Show floating icon",
              type: "checkbox" as const,
              checked: floatingPill.isEnabled(),
              click: (item: Electron.MenuItem) => floatingPill.setEnabled(item.checked),
            },
          ]
        : []),
      // Chosen from an app's menu in Rome, so it is listed only once there is one.
      ...shareShortcutItems(shareShortcut ?? null),
      { type: "separator" },
      {
        // No accelerator: tray menus cannot register shortcuts of their own,
        // so one printed here only advertises a key. The app menu's ⌘Q is the
        // other way out. The Rome keeps running in Rome Cloud; quitting only
        // disconnects this computer.
        label: "Quit Rome",
        enabled: !quitting,
        click: () => {
          requestStopAndQuit();
        },
      },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  rebuildMenu(runtime.getStatus());
  device?.onChange(() => rebuildMenu(runtime.getStatus()));
  runtime.on("status", (status: RuntimeStatus) => rebuildMenu(status));
  shareShortcut?.onChange(() => rebuildMenu(runtime.getStatus()));
  // Hiding the pill from its own menu has to untick the box here.
  floatingPill?.onEnabledChange(() => rebuildMenu(runtime.getStatus()));

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
