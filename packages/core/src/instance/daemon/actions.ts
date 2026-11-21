export const MANAGED_SERVICE_NAMES = ["rome"] as const;
export type ManagedServiceName = (typeof MANAGED_SERVICE_NAMES)[number];

export const DAEMON_ACTIONS = ["restart_rome"] as const;
export type DaemonActionName = (typeof DAEMON_ACTIONS)[number];

export type ManagedServiceState =
  | "stopped"
  | "starting"
  | "running"
  | "unhealthy"
  | "restarting"
  | "building";

export interface ManagedServiceSnapshot {
  name: ManagedServiceName;
  state: ManagedServiceState;
  pid: number | null;
  restartCount: number;
  lastStartedAt: string | null;
  lastExitedAt: string | null;
  lastExitCode: number | null;
  lastExitSignal: NodeJS.Signals | null;
  lastHealthCheckAt: string | null;
  lastHealthyAt: string | null;
  lastUnhealthyAt: string | null;
  lastRestartAt: string | null;
}

export interface DaemonStatusPayload {
  status: "ok" | "degraded";
  intervalMs: number;
  actionInProgress: boolean;
  updatedAt: string;
  services: Record<ManagedServiceName, ManagedServiceSnapshot>;
}

export type DaemonActionRequest = {
  action: "restart_rome";
  threadId: string;
};

export interface DaemonActionResult {
  ok: boolean;
  action: DaemonActionName;
  startedAt: string;
  finishedAt: string;
  status: DaemonStatusPayload["status"];
  services: DaemonStatusPayload["services"];
  error?: string;
}

export function isDaemonActionName(value: unknown): value is DaemonActionName {
  return typeof value === "string" && DAEMON_ACTIONS.includes(value as DaemonActionName);
}

export function parseDaemonActionRequest(value: unknown): DaemonActionRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (!isDaemonActionName(candidate.action)) {
    return null;
  }

  if (typeof candidate.threadId !== "string" || candidate.threadId.trim().length === 0) {
    return null;
  }

  return {
    action: candidate.action,
    threadId: candidate.threadId,
  };
}
