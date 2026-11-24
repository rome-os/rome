// The instance's half of Rome's own Slack app: the calls it makes, with the
// instance's token, to the Slack gateway Worker that holds the app and every
// workspace's bot token, and to Rome Cloud for the link that adds the app to a
// workspace. Contract: rome-cloud docs/slack-gateway.md.

import { getRomeCloudOrigin } from "../../../instance/rome-cloud-origin.js";
import { romeCloudRequest } from "../../../instance/rome-cloud-request.js";

/** A refusal from the Worker or Rome Cloud, in words the guardian can read. */
export class SlackAppRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status, 0 when nothing answered. */
    readonly status: number,
  ) {
    super(message);
    this.name = "SlackAppRefused";
  }
}

/** Whether a refusal says this instance's token is no good there. */
export function isSlackAppCredentialError(error: unknown): boolean {
  return (
    error instanceof SlackAppRefused && (error.status === 401 || error.code === "not_enrolled")
  );
}

/** A workspace the Worker holds for this instance. */
export interface SlackAppWorkspace {
  teamId: string;
  teamName: string;
  botUserId: string;
  /** The member who approved the install, when Slack said. */
  installerUserId?: string;
  /** When it was bound, in epoch ms. A reinstall binds it again. */
  boundAt: number;
}

export interface SlackAppConnected {
  depositKey: string;
  workspaces: SlackAppWorkspace[];
}

export interface SlackAppCloud {
  /** Tells the Worker where this instance's mailbox is. Idempotent: the
   *  deposit key stays the same across connects. */
  connect(depositUrl: string, signal?: AbortSignal): Promise<SlackAppConnected>;
  /** Lets go of every workspace of this instance, revoking each token at
   *  Slack, so any Rome may connect them again. Idempotent. */
  disconnect(signal?: AbortSignal): Promise<void>;
  workspaces(signal?: AbortSignal): Promise<SlackAppWorkspace[]>;
  /** Slack's page where the guardian approves the app for a workspace. */
  installUrl(signal?: AbortSignal): Promise<string>;
}

/** What each refusal means for the guardian. */
function wordsFor(code: string, status: number): string {
  switch (code) {
    case "not_enrolled":
      return "Rome's Slack app needs this Rome linked to Rome Cloud. Link it in Settings, then connect again.";
    case "invalid_deposit_url":
      return "Rome can't receive Slack messages yet. Try again in a minute.";
    case "slack_unavailable":
      return "Slack is unavailable right now. Try again later.";
    default:
      return status === 401
        ? "Rome Cloud did not accept this Rome. Link it again in Settings."
        : `Rome's Slack service answered ${status || "nothing"} (${code}).`;
  }
}

const refuse = (code: string, _message: string | undefined, status: number) =>
  new SlackAppRefused(code, wordsFor(code, status), status);

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function workspacesOf(value: unknown): SlackAppWorkspace[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row: Record<string, unknown> | null) =>
    isString(row?.teamId) && isString(row.botUserId)
      ? [
          {
            teamId: row.teamId,
            teamName: typeof row.teamName === "string" ? row.teamName : "",
            botUserId: row.botUserId,
            ...(isString(row.installerUserId) ? { installerUserId: row.installerUserId } : {}),
            boundAt: Number(row.boundAt) || 0,
          },
        ]
      : [],
  );
}

/** The Slack gateway Worker at `workerOrigin`, such as `https://slack.romeos.io`. */
export function romeCloudSlackApp(
  workerOrigin: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): SlackAppCloud {
  const worker = (
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
    signal?: AbortSignal,
  ) =>
    romeCloudRequest(
      {
        url: new URL(path, workerOrigin),
        method,
        fetchImpl,
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {}),
      },
      refuse,
    );

  return {
    async connect(depositUrl, signal) {
      const data = (await worker("/v1/connect", "POST", { depositUrl }, signal)) as Record<
        string,
        unknown
      > | null;
      if (!isString(data?.depositKey)) throw refuse("invalid_response", undefined, 200);
      return { depositKey: data.depositKey, workspaces: workspacesOf(data.workspaces) };
    },
    async disconnect(signal) {
      await worker("/v1/connect", "DELETE", undefined, signal);
    },
    async workspaces(signal) {
      const data = (await worker("/v1/workspaces", "GET", undefined, signal)) as {
        workspaces?: unknown;
      } | null;
      return workspacesOf(data?.workspaces);
    },
    async installUrl(signal) {
      const origin = getRomeCloudOrigin();
      if (!origin) throw refuse("not_enrolled", undefined, 0);
      const data = (await romeCloudRequest(
        {
          url: new URL("/api/instance/slack/install-url", origin),
          method: "POST",
          fetchImpl,
          ...(signal ? { signal } : {}),
        },
        refuse,
      )) as { url?: unknown } | null;
      if (!isString(data?.url) || !data.url.startsWith("https://slack.com/")) {
        throw refuse("invalid_response", undefined, 200);
      }
      return data.url;
    },
  };
}
