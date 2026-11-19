// The instance's half of adding Rome's own Slack app, talking to Rome Cloud
// with the instance's token. Rome Cloud holds the app's secrets and the
// workspace-to-instance binding; the instance holds the bot token.

import { cloudBearer } from "../../../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../../../instance/rome-cloud-origin.js";

/** The relay mailbox a workspace's events arrive in. */
export interface SlackAppMailbox {
  connectUrl: string;
  drainKey: string;
}

/** What Rome Cloud hands over once the guardian approved the app. */
export interface SlackAppInstall {
  teamId: string;
  teamName?: string;
  botUserId: string;
  botToken: string;
  appId?: string;
  installerUserId?: string;
  scopes: string[];
  mailbox: SlackAppMailbox;
  forwardSecret: string;
  /** Which claim of the workspace this connect made. A release that names it
   *  ends this claim only. Absent from a Rome Cloud that predates it. */
  generation?: number;
}

/** A refusal Rome Cloud explained, in words the guardian can read. */
export class SlackAppRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SlackAppRefused";
  }
}

export interface SlackAppCloud {
  start(input: { callbackOrigin: string; state: string; codeChallenge: string }): Promise<string>;
  redeem(input: { handoff: string; codeVerifier: string }): Promise<SlackAppInstall>;
  refreshMailbox(teamId: string): Promise<SlackAppMailbox>;
  /** Let go of the workspace, so its events go nowhere and any Rome may
   *  connect it again. Releasing one no longer bound is not an error. Given
   *  the `generation` its connect was given, it ends that connect's claim
   *  only, so a release that lands late spares a later connect. */
  release(teamId: string, signal?: AbortSignal, generation?: number): Promise<void>;
}

async function post(
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const origin = getRomeCloudOrigin();
  if (!origin) {
    throw new SlackAppRefused("unconfigured", "This Rome is not set up to reach Rome Cloud.");
  }
  const token = await cloudBearer();
  if (!token) {
    throw new SlackAppRefused(
      "not_enrolled",
      "Rome's Slack app needs this Rome linked to Rome Cloud. Link it in Settings, then connect again.",
    );
  }
  const response = await fetchImpl(new URL(path, origin), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    cache: "no-store",
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => null)) as
    | ({ error?: string; error_description?: string } & Record<string, unknown>)
    | null;
  if (!response.ok) {
    throw new SlackAppRefused(
      data?.error ?? `http_${response.status}`,
      data?.error_description ?? `Rome Cloud answered ${response.status}.`,
    );
  }
  return data;
}

function isMailbox(value: unknown): value is SlackAppMailbox {
  const mailbox = value as Partial<SlackAppMailbox> | null;
  return typeof mailbox?.connectUrl === "string" && typeof mailbox.drainKey === "string";
}

export function romeCloudSlackApp(fetchImpl: typeof fetch = globalThis.fetch): SlackAppCloud {
  return {
    async start(input) {
      const data = (await post("/api/slack/app/start", input, fetchImpl)) as {
        authorizeUrl?: unknown;
      } | null;
      if (typeof data?.authorizeUrl !== "string") {
        throw new SlackAppRefused("invalid_response", "Rome Cloud did not answer with a link.");
      }
      return data.authorizeUrl;
    },
    async redeem(input) {
      const data = (await post(
        "/api/slack/app/token",
        input,
        fetchImpl,
      )) as Partial<SlackAppInstall> | null;
      if (
        typeof data?.teamId !== "string" ||
        typeof data.botUserId !== "string" ||
        typeof data.botToken !== "string" ||
        typeof data.forwardSecret !== "string" ||
        !isMailbox(data.mailbox)
      ) {
        throw new SlackAppRefused("invalid_response", "Rome Cloud's answer was incomplete.");
      }
      const { generation, ...install } = data;
      return {
        scopes: [],
        ...install,
        ...(typeof generation === "number" && Number.isInteger(generation) && generation > 0
          ? { generation }
          : {}),
      } as SlackAppInstall;
    },
    async refreshMailbox(teamId) {
      const data = (await post("/api/slack/app/mailbox", { teamId }, fetchImpl)) as {
        mailbox?: unknown;
      } | null;
      if (!isMailbox(data?.mailbox)) {
        throw new SlackAppRefused("invalid_response", "Rome Cloud's answer was incomplete.");
      }
      return data.mailbox;
    },
    async release(teamId, signal, generation) {
      await post(
        "/api/slack/app/release",
        { teamId, ...(generation !== undefined ? { generation } : {}) },
        fetchImpl,
        signal,
      );
    },
  };
}
