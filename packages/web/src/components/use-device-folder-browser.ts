import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DeviceFilesErrorCode,
  DeviceFilesResponse,
  DeviceList,
} from "@rome/api-types/devices";
import { ChatApiError, listDeviceFiles } from "@/lib/chat-api";

export type PickerDevice = DeviceList["devices"][number];

export interface DeviceBrowse {
  device: PickerDevice;
  folder: DeviceFilesResponse | null;
  loading: boolean;
  error: DeviceFilesErrorCode | null;
}

const deviceErrors = new Set<DeviceFilesErrorCode>(["offline", "upgrade_required"]);

function errorCode(error: unknown): DeviceFilesErrorCode {
  const code = error instanceof ChatApiError ? error.message : "";
  return (
    (
      ["offline", "upgrade_required", "not_found", "not_a_directory", "permission_denied"] as const
    ).find((known) => known === code) ?? "unavailable"
  );
}

/**
 * Folder browsing for the project selector. Opening a device is its only
 * probe. Folders load one `fs.list` at a time, and a newer request discards
 * the answer of an older one.
 */
export function useDeviceFolderBrowser(menuOpen: boolean) {
  const [browse, setBrowse] = useState<DeviceBrowse | null>(null);
  // A device that answered offline or upgrade_required stays disabled until
  // the menu reopens.
  const [deviceErrorById, setDeviceErrorById] = useState<Record<string, DeviceFilesErrorCode>>({});
  const homeById = useRef(new Map<string, string>());
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    if (menuOpen) {
      setDeviceErrorById({});
      return;
    }
    request.current?.abort();
    setBrowse(null);
  }, [menuOpen]);

  const open = useCallback(async (device: PickerDevice, path?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBrowse((current) => ({
      device,
      folder: current?.device.id === device.id ? current.folder : null,
      loading: true,
      error: null,
    }));
    try {
      const folder = await listDeviceFiles(device.id, path, controller.signal);
      if (controller.signal.aborted) return;
      if (!path) homeById.current.set(device.id, folder.path);
      setBrowse({ device, folder, loading: false, error: null });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = errorCode(error);
      // The reason shows here first; back in the list the device stays disabled with it.
      if (deviceErrors.has(code))
        setDeviceErrorById((current) => ({ ...current, [device.id]: code }));
      setBrowse((current) => (current ? { ...current, loading: false, error: code } : current));
    }
  }, []);

  const close = useCallback(() => {
    request.current?.abort();
    setBrowse(null);
  }, []);

  return {
    browse,
    deviceErrorById,
    homeOf: (deviceId: string) => homeById.current.get(deviceId) ?? null,
    open,
    close,
  };
}
