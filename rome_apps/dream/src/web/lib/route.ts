import { useSyncExternalStore } from "react";
import { getCurrentAppPath, subscribeToAppPath } from "@rome-os/app-web-sdk";

export type AppRoute = { view: "home" } | { view: "run"; runId: string };

function parseRoute(path: string): AppRoute {
  const [head, id] = path.replace(/^\/+|\/+$/g, "").split("/");
  if (head === "runs" && id) return { view: "run", runId: decodeURIComponent(id) };
  return { view: "home" };
}

export function runPath(runId: string): string {
  return `runs/${encodeURIComponent(runId)}`;
}

export function useAppRoute(): AppRoute {
  const path = useSyncExternalStore(subscribeToAppPath, getCurrentAppPath, () => "");
  return parseRoute(path);
}
