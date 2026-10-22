import { z } from "zod";

/**
 * A device folder picked in the new-chat draft. `home` is the device user's
 * home folder when the picker learned it, so the label can shorten it to `~`.
 */
export const draftDeviceFolderSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  path: z.string(),
  home: z.string().nullable(),
});
export type DraftDeviceFolder = z.infer<typeof draftDeviceFolderSchema>;

function separatorOf(path: string): "/" | "\\" {
  return /^[A-Za-z]:\\/.test(path) || (path.includes("\\") && !path.includes("/")) ? "\\" : "/";
}

/** `path` with the home folder shortened to `~`. */
export function tildePath(path: string, home: string | null): string {
  if (!home || home === separatorOf(home)) return path;
  if (path === home) return "~";
  const sep = separatorOf(home);
  const prefix = home.endsWith(sep) ? home : home + sep;
  return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

/** Short label for the composer trigger, e.g. `macbook:~/code/foo`. */
export function deviceFolderLabel(folder: DraftDeviceFolder): string {
  return `${folder.deviceName}:${tildePath(folder.path, folder.home)}`;
}

/** The child folder `name` of `path`, using the separator `path` already uses. */
export function childPath(path: string, name: string): string {
  const sep = separatorOf(path);
  return path.endsWith(sep) ? path + name : path + sep + name;
}
