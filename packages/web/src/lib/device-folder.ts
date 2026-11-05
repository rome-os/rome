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

/**
 * Short label for the composer trigger, e.g. `macbook:~/code/foo`. Without a
 * known home, a full path would truncate, so it names the folder only.
 */
export function deviceFolderLabel(folder: DraftDeviceFolder): string {
  const where = folder.home ? tildePath(folder.path, folder.home) : deviceFolderName(folder.path);
  return `${folder.deviceName}:${where}`;
}

/** The child folder `name` of `path`, using the separator `path` already uses. */
export function childPath(path: string, name: string): string {
  const sep = separatorOf(path);
  return path.endsWith(sep) ? path + name : path + sep + name;
}

/** The last segment of a device path, for a short label; the path itself at a root. */
export function deviceFolderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** A path cut after each separator, keyed by the path up to that point. */
export function pathSegments(path: string): { key: string; text: string }[] {
  let prefix = "";
  return path.split(/(?<=[\\/])/).map((text) => {
    prefix += text;
    return { key: prefix, text };
  });
}

/** A folder chosen in the Concierge composer: on a linked device, or a Rome project. */
export type FolderSelection =
  | { kind: "device"; folder: DraftDeviceFolder }
  | { kind: "project"; name: string; path: string };

/** Quoted as is, or as a JSON string when it holds a `"` or a control character. */
function quoted(value: string): string {
  return /["\u0000-\u001f\u007f]/.test(value) ? JSON.stringify(value) : `"${value}"`;
}

/**
 * The one line that tells the Concierge where the guardian pointed. It is fixed
 * English text for the model, and only text: it grants nothing.
 */
export function folderLine(selection: FolderSelection): string {
  if (selection.kind === "project") {
    return `- Folder: ${quoted(selection.path)} (Rome project ${quoted(selection.name)})`;
  }
  const { path, deviceName, deviceId } = selection.folder;
  return `- Folder: ${quoted(path)} on Rome node device ${quoted(deviceName)} (id ${deviceId})`;
}

/**
 * `text` followed by the folder line, set apart by a blank line as the server
 * sets apart its `- File N:` lines. Without text it is the line alone.
 */
export function appendFolderLine(text: string, selection: FolderSelection | null): string {
  if (!selection) return text;
  return [text.trim(), folderLine(selection)].filter(Boolean).join("\n\n");
}
