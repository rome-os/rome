import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CloudInstance } from "@rome-os/libs/native-auth";
import type { CloudAccount } from "./cloud/account";
import type { DeviceStatus } from "./cloud/device-host";
import { getDb } from "./db/database";
import { settings } from "./db/schema";
import { handleFromAppOrInstance, handleTrusted } from "./ipc-trust";
import type { RuntimeController } from "./runtime/controller";
import { localVmSupport } from "./runtime/manager";
import {
  parseRuntimeTarget,
  RUNTIME_TARGET_KEY,
  requireRuntimeTarget,
  type RuntimeTarget,
} from "./runtime/target";

interface IpcHandlerOptions {
  openSettingsWindow: () => void;
  /** Null when this build's Rome Cloud origin cannot back a sign-in. */
  cloudAccount: CloudAccount | null;
  hasLocalRuntime: () => boolean;
  /** This computer as a device of the signed-in account. */
  device: {
    status(): DeviceStatus;
    start(): Promise<void>;
    stop(): Promise<void>;
    setEnabled(enabled: boolean): Promise<void>;
  };
}

interface CloudState {
  available: boolean;
  signedIn: boolean;
  cloudOrigin: string | null;
  activeTarget: RuntimeTarget;
  savedTarget: RuntimeTarget;
  localVm: { supported: boolean; reason: string | null };
  device: DeviceStatus;
}

const settingsGetSchema = z.tuple([z.string().min(1)]);
const settingsSetSchema = z.tuple([z.string().min(1), z.string()]);

function readSetting(key: string): string | null {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  getDb()
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    })
    .run();
}

export function readRuntimeTarget(hasLocalRuntime: boolean): RuntimeTarget {
  return parseRuntimeTarget(readSetting(RUNTIME_TARGET_KEY), hasLocalRuntime);
}

/** The settings key for the user's choice to let Rome use this computer. */
const DEVICE_ENABLED_KEY = "device.enabled";

/** On unless the user turned it off. */
export function readDeviceEnabled(): boolean {
  return readSetting(DEVICE_ENABLED_KEY) !== "false";
}

export function writeDeviceEnabled(enabled: boolean): void {
  writeSetting(DEVICE_ENABLED_KEY, enabled ? "true" : "false");
}

export function writeRuntimeTarget(target: RuntimeTarget): void {
  writeSetting(RUNTIME_TARGET_KEY, JSON.stringify(target));
}

export function registerIpcHandlers(
  controller: RuntimeController,
  options: IpcHandlerOptions,
): void {
  const { cloudAccount } = options;
  const runtime = controller.runtime;

  // ── Settings ──

  handleTrusted("settings:get", (_event, ...args) => {
    const [key] = settingsGetSchema.parse(args);
    return readSetting(key);
  });

  handleTrusted("settings:set", (_event, ...args) => {
    const [key, value] = settingsSetSchema.parse(args);
    writeSetting(key, value);
  });

  handleTrusted("settings:openWindow", () => {
    options.openSettingsWindow();
  });

  // ── Rome Cloud and which Rome to open ──

  const requireAccount = (): CloudAccount => {
    if (!cloudAccount) throw new Error("This build cannot sign in to Rome Cloud.");
    return cloudAccount;
  };

  const cloudState = async (): Promise<CloudState> => ({
    available: cloudAccount !== null,
    signedIn: cloudAccount ? await cloudAccount.isSignedIn() : false,
    cloudOrigin: cloudAccount?.cloudOrigin ?? null,
    activeTarget: controller.activeTarget(),
    savedTarget: readRuntimeTarget(options.hasLocalRuntime()),
    localVm: localVmSupport(),
    device: options.device.status(),
  });

  handleTrusted("cloud:getState", cloudState);

  // ── This computer as a device ──
  // The open Rome's dashboard reads and changes this too: the dashboard is
  // where the user sees the account's devices.

  const instanceOrigin = (): string | null => {
    const target = controller.activeTarget();
    return target.kind === "remote" ? (target.instance?.origin ?? null) : null;
  };

  handleFromAppOrInstance("device:get", instanceOrigin, () => options.device.status());

  handleFromAppOrInstance("device:setEnabled", instanceOrigin, async (_event, value) => {
    await options.device.setEnabled(z.boolean().parse(value));
    return options.device.status();
  });

  handleTrusted("cloud:signIn", async () => {
    await requireAccount().signIn();
    void options.device.start();
    return cloudState();
  });

  handleTrusted("cloud:cancelSignIn", () => {
    cloudAccount?.cancelSignIn();
  });

  handleTrusted("cloud:signOut", async () => {
    requireAccount();
    await options.device.stop();
    await controller.signOut();
    return cloudState();
  });

  handleTrusted("cloud:listInstances", (): Promise<CloudInstance[]> => {
    return requireAccount().listInstances();
  });

  // Returns whether the change applied in place or the app is relaunching.
  handleTrusted("runtime:setTarget", (_event, value) => {
    const target = requireRuntimeTarget(value);
    if (target.kind === "local") {
      const support = localVmSupport();
      if (!support.supported) throw new Error(support.reason ?? "This computer cannot run the VM.");
    }
    return controller.setTarget(target);
  });

  handleTrusted("runtime:chooseInstance", async (_event, value) => {
    const instanceId = z.string().min(1).parse(value);
    await controller.chooseInstance(instanceId);
    return runtime.getStatus();
  });

  // ── Runtime ──

  handleTrusted("runtime:getStatus", () => {
    return runtime.getStatus();
  });

  handleTrusted("runtime:ensureReady", async () => {
    await runtime.ensureReady();
    return runtime.getStatus();
  });

  handleTrusted("runtime:upgrade", async () => {
    await runtime.upgradeRuntime();
    return runtime.getStatus();
  });

  handleTrusted("runtime:openInstallPage", async () => {
    await runtime.openInstallPage();
  });

  handleTrusted("runtime:startRuntimeApp", async () => {
    await runtime.startRuntimeApp();
  });

  handleTrusted("runtime:openRuntimeFolder", async () => {
    await runtime.openRuntimeFolder();
  });

  handleTrusted("runtime:openLogs", async () => {
    await runtime.openLogs();
  });
}
