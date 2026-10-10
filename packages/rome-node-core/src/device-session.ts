import { platform } from "node:os";
import { isRecord } from "./actions.js";
import { validId } from "./protocol.js";

export interface DeviceSession {
  cloudUrl: string;
  token: string;
  deviceId: string;
}

export function devicePlatform(): "macos" | "windows" | "linux" {
  const value = platform();
  return value === "darwin" ? "macos" : value === "win32" ? "windows" : "linux";
}

export function deviceSessionFromToken(body: unknown, origin: string): DeviceSession | null {
  if (
    !isRecord(body) ||
    typeof body.access_token !== "string" ||
    !/^romedev_[A-Za-z0-9_-]{43}$/.test(body.access_token) ||
    body.token_type !== "Bearer" ||
    !validId(body.device_id)
  )
    return null;
  return { cloudUrl: origin, token: body.access_token, deviceId: body.device_id };
}
