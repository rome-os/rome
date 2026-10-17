import type { KeyValueStorage } from "./instance-store";
import { type CloudInstance, parseCloudInstance } from "@rome-os/libs/native-auth";

const SELECTED_INSTANCE_KEY = "rome.selected-instance.v1";

export async function loadSelectedInstance(
  storage: KeyValueStorage,
  cloudOrigin: string,
): Promise<CloudInstance | null> {
  const raw = await storage.getItem(SELECTED_INSTANCE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { cloudOrigin?: unknown; instance?: unknown };
    if (value.cloudOrigin !== cloudOrigin) return null;
    return parseCloudInstance(value.instance);
  } catch {
    return null;
  }
}

export function saveSelectedInstance(
  storage: KeyValueStorage,
  cloudOrigin: string,
  instance: CloudInstance,
): Promise<void> {
  return storage.setItem(SELECTED_INSTANCE_KEY, JSON.stringify({ cloudOrigin, instance }));
}

export function clearSelectedInstance(storage: KeyValueStorage): Promise<void> {
  return storage.removeItem(SELECTED_INSTANCE_KEY);
}
