import { contextBridge, ipcRenderer } from "electron";

/**
 * This computer as a device of the signed-in account. The open Rome's
 * dashboard gets this too; main answers only that origin and the app's pages.
 */
const device = {
  get: (): Promise<DeviceStatus> => ipcRenderer.invoke("device:get"),
  setEnabled: (enabled: boolean): Promise<DeviceStatus> =>
    ipcRenderer.invoke("device:setEnabled", enabled),
  onStatus: (callback: (status: DeviceStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: DeviceStatus) => callback(status);
    ipcRenderer.on("device:status", listener);
    return () => ipcRenderer.removeListener("device:status", listener);
  },
};

/**
 * Exposed API for renderer processes.
 * Accessed via `window.rome` in the renderer.
 */
const api = {
  device,

  settings: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke("settings:get", key),
    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke("settings:set", key, value),
    openWindow: (): Promise<void> => ipcRenderer.invoke("settings:openWindow"),
  },

  cloud: {
    getState: (): Promise<CloudState> => ipcRenderer.invoke("cloud:getState"),
    signIn: (): Promise<CloudState> => ipcRenderer.invoke("cloud:signIn"),
    cancelSignIn: (): Promise<void> => ipcRenderer.invoke("cloud:cancelSignIn"),
    signOut: (): Promise<CloudState> => ipcRenderer.invoke("cloud:signOut"),
    listInstances: (): Promise<CloudInstance[]> => ipcRenderer.invoke("cloud:listInstances"),
  },

  runtime: {
    getStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke("runtime:getStatus"),
    setTarget: (target: RuntimeTarget): Promise<"switched" | "relaunching"> =>
      ipcRenderer.invoke("runtime:setTarget", target),
    chooseInstance: (instanceId: string): Promise<RuntimeStatus> =>
      ipcRenderer.invoke("runtime:chooseInstance", instanceId),
    ensureReady: (): Promise<RuntimeStatus> => ipcRenderer.invoke("runtime:ensureReady"),
    openInstallPage: (): Promise<void> => ipcRenderer.invoke("runtime:openInstallPage"),
    startRuntimeApp: (): Promise<void> => ipcRenderer.invoke("runtime:startRuntimeApp"),
    openRuntimeFolder: (): Promise<void> => ipcRenderer.invoke("runtime:openRuntimeFolder"),
    openLogs: (): Promise<void> => ipcRenderer.invoke("runtime:openLogs"),
  },

  updater: {
    getStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:getStatus"),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:check"),
    download: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:download"),
    install: (): Promise<UpdateStatus> => ipcRenderer.invoke("updater:install"),
    setAutoUpdateEnabled: (enabled: boolean): Promise<UpdateStatus> =>
      ipcRenderer.invoke("updater:setAutoUpdateEnabled", enabled),
  },

  romeImage: {
    getStatus: (): Promise<ImageUpdateStatus> => ipcRenderer.invoke("rome-image:getStatus"),
    check: (): Promise<ImageUpdateStatus> => ipcRenderer.invoke("rome-image:check"),
    setAutoUpdateEnabled: (enabled: boolean): Promise<ImageUpdateStatus> =>
      ipcRenderer.invoke("rome-image:setAutoUpdateEnabled", enabled),
  },

  // One-way on purpose: the pill never needs an answer, and the main process
  // owns all window geometry — the page only reports gestures.
  pill: {
    ready: (): void => ipcRenderer.send("pill:ready"),
    setSize: (width: number, height: number): void =>
      ipcRenderer.send("pill:setSize", width, height),
    click: (): void => ipcRenderer.send("pill:click"),
    dragStart: (grabX: number, grabY: number): void =>
      ipcRenderer.send("pill:dragStart", grabX, grabY),
    dragMove: (): void => ipcRenderer.send("pill:dragMove"),
    dragEnd: (): void => ipcRenderer.send("pill:dragEnd"),
    contextMenu: (): void => ipcRenderer.send("pill:contextMenu"),
  },

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels = [
      "updater:status",
      "runtime:status",
      "rome-image:status",
      "pill:name",
      "device:status",
    ];
    if (validChannels.includes(channel)) {
      const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
    return () => {};
  },
};

// The app's own pages load from file: and get the whole bridge. Anything else
// in the main window is the dashboard, possibly a Rome on the internet, or a
// sign-in page. It gets the marker that says "inside the Mac app" (see
// `isElectronShell` in the dashboard) and the device bridge, which main answers
// only for the Rome this launch opened. Main refuses everything else.
contextBridge.exposeInMainWorld("rome", location.protocol === "file:" ? api : { device });

// Tag the document so the web app can conditionally apply
// Electron-shell-only styles (drag regions, traffic-light insets) without
// affecting the pure-web build. Acts as a poor-man's media query: web users
// never see the class, so rules scoped to `html.is-electron` are a no-op there.
function applyShellHints(): void {
  const root = document.documentElement;
  root.classList.add("is-electron");
  root.classList.add(`platform-${process.platform}`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyShellHints, { once: true });
} else {
  applyShellHints();
}

interface RuntimeStatus {
  phase: string;
  title: string;
  detail: string;
  primaryAction: string;
  dashboardUrl: string;
  healthUrl: string;
  installDir: string;
  image: string;
  containerName: string;
  provider: "lima" | "remote";
  runtimeInstalled: boolean;
  runtimeRunning: boolean;
  runtimeInstallUrl: string;
  lastError: string | null;
  pullProgress: {
    percent: number | null;
    status: string;
    currentBytes: number;
    totalBytes: number;
    layersCompleted: number;
    layersTotal: number;
  } | null;
}

interface UpdateStatus {
  state:
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "downloaded"
    | "error";
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

interface ImageUpdateStatus {
  state: "idle" | "checking" | "up-to-date" | "available" | "updating" | "error" | "unsupported";
  image: string;
  currentDigest: string | null;
  latestDigest: string | null;
  autoUpdateEnabled: boolean;
  lastCheckedAt: string | null;
  message: string;
  error: string | null;
}

type RuntimeTarget =
  | { kind: "local" }
  | { kind: "remote"; instance: { id: string; name: string; origin: string } | null };

type DeviceStatus =
  | { state: "off" }
  | { state: "disabled" | "connecting" | "connected" | "offline"; deviceId: string; name: string };

interface CloudState {
  available: boolean;
  signedIn: boolean;
  cloudOrigin: string | null;
  activeTarget: RuntimeTarget;
  savedTarget: RuntimeTarget;
  localVm: { supported: boolean; reason: string | null };
  device: DeviceStatus;
}

interface CloudInstance {
  id: string;
  name: string;
  slug: string;
  origin: string;
  status: string;
}
