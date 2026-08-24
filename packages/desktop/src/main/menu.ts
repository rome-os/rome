import { app, Menu, BrowserWindow, shell } from "electron";
import { requestStopAndQuit } from "./lifecycle";

const DOCS_URL = "https://romeos.cc/docs/rome";

export function setupApplicationMenu(
  showDashboard: () => void,
  openSettings: () => BrowserWindow,
  checkForUpdates: () => void | Promise<unknown>,
): void {
  const isMac = process.platform === "darwin";

  // Tray-resident model: ⌘Q is the only quit, and it stops the agent on its
  // way out. `role: "close"` closes the focused window, which window.ts
  // intercepts and turns into a hide unless lifecycle.isQuitting() is true.
  const quitItem: Electron.MenuItemConstructorOptions = {
    label: "Quit Rome",
    accelerator: "CmdOrCtrl+Q",
    click: () => requestStopAndQuit(),
  };

  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => openSettings(),
  };

  const checkForUpdatesItem: Electron.MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => {
      void checkForUpdates();
    },
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only). Everything about the application itself: its
    // version, its updates, and its own preferences — which is the desktop
    // shell's settings window, not the dashboard's Settings page. The sidebar
    // owns that one, and it is user-customisable, so no menu mirrors it.
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              checkForUpdatesItem,
              { type: "separator" as const },
              settingsItem,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              quitItem,
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),

    // File menu. On macOS this is Electron's own `fileMenu` role spelled out:
    // one Close. Not the role itself, because its non-mac branch is
    // `role: "quit"`, which calls app.quit() directly and would skip stopping
    // the runtime.
    //
    // Windows and Linux have no app menu, so what lives there on a Mac hangs
    // here — unchanged from before this commit, since nothing builds for them.
    {
      label: "File",
      submenu: [
        { role: "close" },
        ...(isMac
          ? []
          : [
              { type: "separator" as const },
              settingsItem,
              {
                label: "Stop agent and quit",
                accelerator: "Shift+CmdOrCtrl+Q",
                click: () => requestStopAndQuit(),
              } as Electron.MenuItemConstructorOptions,
            ]),
      ],
    },

    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },

    // View menu. The dashboard entry is here rather than under Window because
    // it navigates content — and because it is the only way back when a
    // provider's OAuth page has taken over this frameless window.
    {
      label: "View",
      submenu: [
        {
          label: "Show Rome Dashboard",
          accelerator: "CmdOrCtrl+Shift+D",
          click: () => showDashboard(),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },

    // The role is what makes AppKit list the open windows; a hand-rolled
    // Window menu gets minimize and zoom but never the list.
    { role: "windowMenu" },

    {
      role: "help",
      submenu: [
        {
          label: "Rome Help",
          click: () => {
            void shell.openExternal(DOCS_URL);
          },
        },
        // Updates move to the app menu on a Mac; without one they stay here.
        ...(isMac ? [] : [checkForUpdatesItem]),
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
