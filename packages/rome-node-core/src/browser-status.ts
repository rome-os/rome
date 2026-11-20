import { isRecord } from "./actions.js";

interface BrowserStatus {
  daemonVersion?: string;
  profiles: { contextId: string; extensionConnected: boolean; extensionVersion?: string }[];
}

export async function readBrowserStatus(request: typeof fetch = fetch): Promise<BrowserStatus> {
  const response = await request("http://127.0.0.1:19825/status", {
    headers: { "X-OpenCLI": "1" },
    signal: AbortSignal.timeout(2_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("OpenCLI did not return its status.");
  const value: unknown = await response.json();
  if (
    !isRecord(value) ||
    value.ok !== true ||
    (value.daemonVersion !== undefined && typeof value.daemonVersion !== "string") ||
    !Array.isArray(value.profiles) ||
    !value.profiles.every(
      (p) =>
        isRecord(p) &&
        typeof p.contextId === "string" &&
        p.contextId.length > 0 &&
        typeof p.extensionConnected === "boolean" &&
        (p.extensionVersion === undefined || typeof p.extensionVersion === "string"),
    )
  )
    throw new Error("Invalid OpenCLI status.");
  return { daemonVersion: value.daemonVersion, profiles: value.profiles };
}
