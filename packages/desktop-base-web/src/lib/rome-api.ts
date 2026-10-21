export type RuntimePhase =
  | "checking_host"
  | "installing_runtime"
  | "starting_runtime"
  | "pulling_image"
  | "starting_rome"
  | "waiting_for_health"
  | "ready"
  | "waiting_for_user"
  | "failed";

export type RuntimePrimaryAction =
  | "install_runtime"
  | "open_runtime_app"
  | "retry"
  | "open_dashboard"
  | "sign_in"
  | "choose_instance"
  | "open_cloud"
  | "none";

export interface RuntimePullProgress {
  percent: number | null;
  status: string;
  currentBytes: number;
  totalBytes: number;
  layersCompleted: number;
  layersTotal: number;
  phase: "downloading" | "unpacking" | "done";
}

export interface RuntimeStatus {
  phase: RuntimePhase;
  title: string;
  detail: string;
  primaryAction: RuntimePrimaryAction;
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
  pullProgress: RuntimePullProgress | null;
}

export type UpdaterState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateStatus {
  state: UpdaterState;
  autoUpdateEnabled: boolean;
  currentVersion: string;
  updateVersion: string | null;
  lastCheckedAt: string | null;
  message: string;
  error: string | null;
  progress: UpdaterProgress | null;
}

export type ImageUpdateState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "updating"
  | "error"
  | "unsupported";

export interface ImageUpdateStatus {
  state: ImageUpdateState;
  image: string;
  currentDigest: string | null;
  latestDigest: string | null;
  autoUpdateEnabled: boolean;
  lastCheckedAt: string | null;
  message: string;
  error: string | null;
}

/** Which Rome the app opens; a change applies when the app restarts. */
/**
 * Which Rome the app opens. A remote target with no instance is Rome Cloud
 * mode before one is picked, which is where a new install starts.
 */
export type RuntimeTarget =
  | { kind: "local" }
  | { kind: "remote"; instance: { id: string; name: string; origin: string } | null };

/** Whether this computer is reachable as a device of the signed-in account. */
export type DeviceStatus =
  | { state: "off" }
  | { state: "disabled" | "connecting" | "connected" | "offline"; deviceId: string; name: string };

export interface CloudState {
  /** False when this build's Rome Cloud origin cannot back a sign-in. */
  available: boolean;
  signedIn: boolean;
  cloudOrigin: string | null;
  /** The Rome this launch opened. */
  activeTarget: RuntimeTarget;
  /** The Rome the next launch opens. */
  savedTarget: RuntimeTarget;
  /** Whether this computer can run the private VM, and why not. */
  localVm: { supported: boolean; reason: string | null };
  device: DeviceStatus;
}

export interface CloudInstance {
  id: string;
  name: string;
  slug: string;
  origin: string;
  status: string;
}

export type InstanceEnrollResult =
  | { ok: true; instanceId: string; account: { id: string; email: string } | null }
  | { ok: false; error: string };

export interface RomeApi {
  settings: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    openWindow(): Promise<void>;
  };
  instance: {
    enroll(): Promise<InstanceEnrollResult>;
  };
  cloud: {
    getState(): Promise<CloudState>;
    signIn(): Promise<CloudState>;
    cancelSignIn(): Promise<void>;
    signOut(): Promise<CloudState>;
    listInstances(): Promise<CloudInstance[]>;
  };
  runtime: {
    getStatus(): Promise<RuntimeStatus>;
    /** Applies in place on the welcome screen, otherwise relaunches. */
    setTarget(target: RuntimeTarget): Promise<"switched" | "relaunching">;
    chooseInstance(instanceId: string): Promise<RuntimeStatus>;
    ensureReady(): Promise<RuntimeStatus>;
    openInstallPage(): Promise<void>;
    startRuntimeApp(): Promise<void>;
    openRuntimeFolder(): Promise<void>;
    openLogs(): Promise<void>;
  };
  updater: {
    getStatus(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    download(): Promise<UpdateStatus>;
    install(): Promise<UpdateStatus>;
    setAutoUpdateEnabled(enabled: boolean): Promise<UpdateStatus>;
  };
  romeImage: {
    getStatus(): Promise<ImageUpdateStatus>;
    check(): Promise<ImageUpdateStatus>;
    setAutoUpdateEnabled(enabled: boolean): Promise<ImageUpdateStatus>;
  };
  pill: {
    ready(): void;
    setSize(width: number, height: number): void;
    click(): void;
    dragStart(grabX: number, grabY: number): void;
    dragMove(): void;
    dragEnd(): void;
    contextMenu(): void;
  };
  on(channel: "runtime:status", callback: (status: RuntimeStatus) => void): () => void;
  on(channel: "updater:status", callback: (status: UpdateStatus) => void): () => void;
  on(channel: "rome-image:status", callback: (status: ImageUpdateStatus) => void): () => void;
  on(channel: "pill:name", callback: (name: string) => void): () => void;
  on(channel: "device:status", callback: (status: DeviceStatus) => void): () => void;
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
}

declare global {
  interface Window {
    rome: RomeApi;
  }
}

function createMockRomeApi(): RomeApi {
  const MOCK_RUNTIME_STATUS: RuntimeStatus = {
    phase: "pulling_image",
    title: "Downloading Rome",
    detail: "Pulling the Rome image for the first time.",
    primaryAction: "none",
    dashboardUrl: "http://localhost:4141",
    healthUrl: "http://localhost:4141/health",
    installDir: "/Users/dev/.rome",
    image: "ghcr.io/rome/rome:latest",
    containerName: "rome",
    provider: "lima",
    runtimeInstalled: true,
    runtimeRunning: true,
    runtimeInstallUrl: "https://lima-vm.io",
    lastError: null,
    pullProgress: {
      phase: "downloading",
      percent: 42,
      status: "Downloading",
      currentBytes: 420_000_000,
      totalBytes: 1_000_000_000,
      layersCompleted: 3,
      layersTotal: 7,
    },
  };

  const MOCK_UPDATE_STATUS: UpdateStatus = {
    state: "not-available",
    autoUpdateEnabled: true,
    currentVersion: "0.1.7",
    updateVersion: "0.1.7",
    lastCheckedAt: new Date().toISOString(),
    message: "Rome is up to date.",
    error: null,
    progress: null,
  };

  const MOCK_IMAGE_UPDATE_STATUS: ImageUpdateStatus = {
    state: "available",
    image: "yunfanye/rome:latest",
    currentDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    latestDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    autoUpdateEnabled: true,
    lastCheckedAt: new Date().toISOString(),
    message: "A newer Rome image is available.",
    error: null,
  };

  const MOCK_CLOUD_STATE: CloudState = {
    available: true,
    signedIn: true,
    cloudOrigin: "https://romeos.cc",
    activeTarget: { kind: "local" },
    savedTarget: { kind: "local" },
    localVm: { supported: true, reason: null },
    device: { state: "off" },
  };

  const log = (name: string, ...args: unknown[]) =>
    console.info(`[rome-api mock] ${name}`, ...args);

  return {
    settings: {
      get: async (key) => {
        log("settings.get", key);
        return null;
      },
      set: async (key, value) => {
        log("settings.set", key, value);
      },
      openWindow: async () => {
        log("settings.openWindow");
      },
    },
    instance: {
      enroll: async () => {
        log("instance.enroll");
        return {
          ok: true,
          instanceId: "inst-mock",
          account: { id: "acct-mock", email: "dev@example.com" },
        };
      },
    },
    cloud: {
      getState: async () => MOCK_CLOUD_STATE,
      signIn: async () => {
        log("cloud.signIn");
        return { ...MOCK_CLOUD_STATE, signedIn: true };
      },
      cancelSignIn: async () => {
        log("cloud.cancelSignIn");
      },
      signOut: async () => {
        log("cloud.signOut");
        return { ...MOCK_CLOUD_STATE, signedIn: false };
      },
      listInstances: async () => [
        {
          id: "instance-mock",
          name: "ray",
          slug: "ray",
          origin: "https://ray.romeos.cc",
          status: "running",
        },
      ],
    },
    runtime: {
      getStatus: async () => MOCK_RUNTIME_STATUS,
      setTarget: async (target) => {
        log("runtime.setTarget", target);
        return "relaunching";
      },
      chooseInstance: async (instanceId) => {
        log("runtime.chooseInstance", instanceId);
        return MOCK_RUNTIME_STATUS;
      },
      ensureReady: async () => {
        log("runtime.ensureReady");
        return MOCK_RUNTIME_STATUS;
      },
      openInstallPage: async () => {
        log("runtime.openInstallPage");
      },
      startRuntimeApp: async () => {
        log("runtime.startRuntimeApp");
      },
      openRuntimeFolder: async () => {
        log("runtime.openRuntimeFolder");
      },
      openLogs: async () => {
        log("runtime.openLogs");
      },
    },
    updater: {
      getStatus: async () => MOCK_UPDATE_STATUS,
      check: async () => {
        log("updater.check");
        return MOCK_UPDATE_STATUS;
      },
      download: async () => {
        log("updater.download");
        return MOCK_UPDATE_STATUS;
      },
      install: async () => {
        log("updater.install");
        return MOCK_UPDATE_STATUS;
      },
      setAutoUpdateEnabled: async (enabled) => {
        log("updater.setAutoUpdateEnabled", enabled);
        return { ...MOCK_UPDATE_STATUS, autoUpdateEnabled: enabled };
      },
    },
    romeImage: {
      getStatus: async () => MOCK_IMAGE_UPDATE_STATUS,
      check: async () => {
        log("romeImage.check");
        return MOCK_IMAGE_UPDATE_STATUS;
      },
      setAutoUpdateEnabled: async (enabled) => {
        log("romeImage.setAutoUpdateEnabled", enabled);
        return { ...MOCK_IMAGE_UPDATE_STATUS, autoUpdateEnabled: enabled };
      },
    },
    pill: {
      ready: () => log("pill.ready"),
      setSize: (width, height) => log("pill.setSize", width, height),
      click: () => log("pill.click"),
      dragStart: (grabX, grabY) => log("pill.dragStart", grabX, grabY),
      dragMove: () => {},
      dragEnd: () => log("pill.dragEnd"),
      contextMenu: () => log("pill.contextMenu"),
    },
    on: () => () => {},
  };
}

function resolveRomeApi(): RomeApi {
  if (window.rome) return window.rome;
  if (process.env.NODE_ENV === "development") {
    console.warn("[rome-api] window.rome missing, falling back to dev mock.");
    return createMockRomeApi();
  }
  throw new Error("window.rome bridge is unavailable — preload script did not run.");
}

export const romeApi: RomeApi = resolveRomeApi();

/**
 * The message a person should read. Errors from main arrive wrapped as
 * "Error invoking remote method 'x': NativeAuthError: …"; only the last part
 * means anything to them.
 */
export function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/^Error invoking remote method '[^']*': /, "")
    .replace(/^(?:[A-Za-z]*Error): /, "");
}
