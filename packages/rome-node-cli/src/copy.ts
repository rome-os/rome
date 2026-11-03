// Maps `rome-node cp` arguments to a copy request. Copy semantics: docs/rome-node.md#copying-files.
import { resolve } from "node:path";
import { isUuid } from "@rome-os/node-core";
import type { CopyRequest } from "@rome-os/node-core/client";

/** A local path when deviceId is absent, otherwise a path on that device. */
export interface CopyLocation {
  deviceId?: string;
  path: string;
}

/** Parses `<device-id>:<path>` as a device path and anything else as a local path. */
export function parseLocation(value: string): CopyLocation {
  const separator = value.indexOf(":");
  const prefix = value.slice(0, separator);
  if (separator === 36 && isUuid(prefix)) {
    if (separator === value.length - 1) throw new Error("A path is required after <device-id>:.");
    return { deviceId: prefix.toLowerCase(), path: value.slice(separator + 1) };
  }
  if (!value) throw new Error("A path is required.");
  return { path: value };
}

/**
 * Builds the request for `rome-node cp <source> <destination>`. Exactly one side is a device path.
 * A destination ending in / or \ gets the source file name. Local paths resolve against `cwd`.
 */
export function copyRequest(source: string, destination: string, cwd: string): CopyRequest {
  const from = parseLocation(source);
  const to = parseLocation(destination);
  if (from.deviceId && to.deviceId)
    throw new Error(
      "Copy between two devices in two steps through this computer: " +
        "rome-node cp <device-a>:<path> <local-file>, then rome-node cp <local-file> <device-b>:<path>.",
    );
  if (!from.deviceId && !to.deviceId)
    throw new Error("One side must be a device path: <device-id>:<path>.");
  let target = to.path;
  if (/[\\/]$/.test(target)) {
    const name = from.path.split(/[\\/]/).filter(Boolean).pop();
    if (!name) throw new Error("The source path has no file name.");
    target += name;
  }
  return from.deviceId
    ? {
        direction: "pull",
        deviceId: from.deviceId,
        remotePath: from.path,
        localPath: resolve(cwd, target),
      }
    : {
        direction: "push",
        deviceId: to.deviceId as string,
        remotePath: target,
        localPath: resolve(cwd, from.path),
      };
}
