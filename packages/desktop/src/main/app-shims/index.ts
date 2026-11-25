import { randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { basename, dirname, join } from "path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  net,
  shell,
  type AppShimHost,
} from "electron";
import { createLogger } from "../logger";
import {
  cdhashRequirement,
  execFileAsync,
  type ExecFile,
  pngsToIcns,
  SHIM_ENTITLEMENTS,
  shimAppName,
  shimBundleFiles,
  shimBundleId,
  shimInfoPlist,
  shimServerName,
  signShimBundle,
} from "./bundle";
import { fetchAppIdentity } from "./identity";
import { type AppShimRecord, readAppShims, saveAppShim, type SettingsAccess } from "./store";

const log = createLogger("app-shims");

const ICON_SIZES = [128, 256, 512];

/** This app's own bundle, which shims load their framework from. */
function hostBundlePath(): string {
  return join(process.resourcesPath, "..", "..");
}

function hostBundleId(): string {
  try {
    const plist = readFileSync(join(hostBundlePath(), "Contents", "Info.plist"), "utf8");
    const id = /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9.-]+)<\/string>/.exec(
      plist,
    )?.[1];
    if (id) return id;
  } catch {
    // Read below from what a build of this app is.
  }
  return app.isPackaged ? "com.rome.desktop" : "com.github.Electron";
}

function loaderPath(): string {
  return join(
    hostBundlePath(),
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Helpers",
    "app_shim_loader",
  );
}

/** Whether this build can put apps on the Desktop: macOS, with an Electron that has app shims. */
export function appShimsSupported(): boolean {
  return process.platform === "darwin" && typeof app.startAppShimServer === "function";
}

function iconImages(png: Buffer): Array<{ size: number; png: Buffer }> {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return [];
  return ICON_SIZES.map((size) => ({
    size,
    png: image.resize({ width: size, height: size, quality: "best" }).toPNG(),
  }));
}

/** `<name>.app` on the Desktop, or `<name> 2.app`… when that one is someone else's. */
function desktopPath(desktop: string, name: string, ours: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = join(desktop, `${n === 1 ? name : `${name} ${n}`}.app`);
    if (!existsSync(candidate) || ours.has(candidate)) return candidate;
  }
}

async function moveInto(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(source, destination, { recursive: true, verbatimSymlinks: true });
  }
}

export interface AppShims {
  /** Puts the Rome app `appId` of `origin` on the Desktop and returns where. */
  addToDesktop(origin: string, appId: string): Promise<{ path: string }>;
}

/**
 * Starts answering shims and returns the way to make them. A Rome app put on
 * the Desktop is a shim bundle (see ./bundle.ts); when it opens, it connects
 * here and gets one window showing the app's full-screen page.
 */
export function setupAppShims(settings: SettingsAccess, exec: ExecFile = execFileAsync): AppShims {
  const hostId = hostBundleId();
  const open = new Map<string, { shim: AppShimHost; window: BrowserWindow | null }>();

  const openWindow = (shim: AppShimHost, record: AppShimRecord): BrowserWindow => {
    const window = new BrowserWindow({
      appShim: shim,
      width: 1100,
      height: 760,
      minWidth: 400,
      minHeight: 300,
      title: record.name,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.once("ready-to-show", () => window.show());
    // As in the main window: a new window is a link out, for the system browser.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    // The app is its one window: closing it quits the app, as a web app does.
    window.on("closed", () => {
      if (shim.isConnected()) shim.quit();
    });
    window.loadURL(record.url).catch((err: unknown) => {
      log.warn(`${record.name} did not load: ${err instanceof Error ? err.message : String(err)}`);
    });
    return window;
  };

  const shimMenu = (name: string): Menu =>
    Menu.buildFromTemplate([
      {
        label: name,
        submenu: [
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]);

  const onConnected = (shim: AppShimHost): void => {
    const record = readAppShims(settings).find(
      (r) => shimBundleId(hostId, r.installId) === shim.bundleId,
    );
    let trusted = false;
    if (record) {
      try {
        trusted = shim.satisfiesCodeRequirement(cdhashRequirement(record.cdhash));
      } catch {
        trusted = false;
      }
    }
    if (!record || !trusted) {
      log.warn(
        `Refused ${shim.bundleId} (pid ${shim.pid}): not an app Rome put on the Desktop`,
      );
      shim.quit();
      return;
    }
    shim.setApplicationMenu(shimMenu(record.name));
    const entry = { shim, window: openWindow(shim, record) as BrowserWindow | null };
    open.set(record.installId, entry);
    shim.on("activate", () => {
      if (!entry.window || entry.window.isDestroyed()) {
        entry.window = openWindow(shim, record);
        return;
      }
      entry.window.show();
      entry.window.focus();
    });
    shim.on("disconnected", () => {
      if (open.get(record.installId) === entry) open.delete(record.installId);
    });
    log.info(`${record.name} opened from the Desktop`);
  };

  if (appShimsSupported()) {
    try {
      app.startAppShimServer({ name: shimServerName(hostId) });
      app.on("app-shim-connected", (_event, shim) => onConnected(shim));
      app.on("app-shim-version-mismatch", () => {
        void dialog.showMessageBox({
          type: "info",
          message: "Restart Rome to open this app",
          detail: "Rome was updated while it was running.",
        });
      });
    } catch (err) {
      log.warn(
        `Apps on the Desktop can't open: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const addToDesktop = async (origin: string, appId: string): Promise<{ path: string }> => {
    if (!appShimsSupported()) throw new Error("Apps can be added to the Desktop on macOS only.");
    const identity = await fetchAppIdentity((url) => net.fetch(url), origin, appId);
    const images = identity.icon ? iconImages(identity.icon) : [];
    if (images.length === 0) throw new Error("This app's icon could not be read.");

    const records = readAppShims(settings);
    const name = shimAppName(identity.name, existsSync, join(homedir(), "Applications"));
    // Adding the same app again replaces the copy Rome put there.
    const previous = records.filter((r) => r.appId === appId && r.url === identity.url);
    const ours = new Set(previous.map((r) => r.bundlePath));
    const destination = desktopPath(app.getPath("desktop"), name, ours);

    // A replaced copy keeps its bundle id, which macOS has already registered
    // for that path and a Dock pin points at.
    const installId =
      previous.find((r) => r.bundlePath === destination)?.installId ??
      randomBytes(6).toString("hex");
    const bundleId = shimBundleId(hostId, installId);
    const staging = await mkdtemp(join(tmpdir(), "rome-app-shim-"));
    try {
      const bundle = join(staging, basename(destination));
      const files = shimBundleFiles({
        plist: shimInfoPlist({
          bundleId,
          name: basename(destination, ".app"),
          appId,
          host: { path: hostBundlePath(), bundleId: hostId, serverName: shimServerName(hostId) },
        }),
        executable: await readFile(loaderPath()),
        icns: pngsToIcns(images),
      });
      for (const file of files) {
        const path = join(bundle, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.data, { mode: file.mode });
      }
      const entitlements = join(staging, "entitlements.plist");
      await writeFile(entitlements, SHIM_ENTITLEMENTS);
      const cdhash = await signShimBundle(exec, bundle, bundleId, entitlements);

      for (const record of previous) {
        open.get(record.installId)?.shim.quit();
      }
      if (ours.has(destination)) await rm(destination, { recursive: true, force: true });
      await moveInto(bundle, destination);
      saveAppShim(settings, {
        installId,
        appId,
        url: identity.url,
        name: basename(destination, ".app"),
        bundlePath: destination,
        cdhash,
      });
      log.info(`Put ${identity.name} on the Desktop`);
      return { path: destination };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };

  return { addToDesktop };
}
