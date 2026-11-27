import {
  COMPUTER_CONSENT_EVENT,
  COMPUTER_CONSENT_SOURCE,
  type ConsentWatchParams,
} from "../agent/index.js";
import { z } from "zod";
import type { createNodeDevicesService } from "../desktops/node-devices.js";
import type { CatalogEntry } from "../event-catalog.js";
import { createLogger } from "../logger.js";

const log = createLogger("computer-consent");
const request = z.object({ requestId: z.string(), reason: z.string().optional() });
const versioned = request.extend({ revision: z.number().int().nonnegative() });
const active = versioned.extend({ expiresInMs: z.number().int().nonnegative() });
const missing = z.array(z.enum(["accessibility", "screen_recording"]));
const statusSchema = z.discriminatedUnion("status", [
  active.extend({ status: z.enum(["pending_consent", "authorized"]) }),
  active.extend({
    status: z.literal("needs_system_permission"),
    missing,
    guideOpened: z.boolean(),
  }),
  versioned.extend({ status: z.enum(["consent_denied", "consent_expired", "cancelled"]) }),
  versioned.extend({ status: z.literal("permissions_expired"), missing }),
  request.extend({ status: z.literal("not_found") }),
]);

type ComputerConsentPayload = z.infer<typeof statusSchema> & { deviceId: string };

export const computerConsentCatalogEntry: CatalogEntry = {
  eventType: COMPUTER_CONSENT_EVENT,
  appId: COMPUTER_CONSENT_SOURCE,
  schemaOrigin: "declared",
  payloadSchema: {
    type: "object",
    properties: { deviceId: { type: "string" } },
    required: ["deviceId"],
    allOf: [z.toJSONSchema(statusSchema, { io: "input" })],
  },
};

export interface ConsentWatch {
  stop(): void;
}

interface WatchEntry {
  afterRevision?: number;
  onChange: (payload: ComputerConsentPayload) => void;
}

interface Poll {
  deviceId: string;
  requestId: string;
  watches: Set<WatchEntry>;
  timer?: NodeJS.Timeout;
  reading?: boolean;
  lastError?: string;
}

/** Routines for the same request share a read but may have seen different revisions. */
export class ComputerConsentWatcher {
  private readonly polls = new Map<string, Poll>();

  constructor(
    private readonly devices: Pick<ReturnType<typeof createNodeDevicesService>, "runAction">,
  ) {}

  watch(
    { deviceId, requestId, afterRevision }: ConsentWatchParams,
    onChange: (payload: ComputerConsentPayload) => void,
  ): ConsentWatch {
    const key = JSON.stringify([deviceId, requestId]);
    let poll = this.polls.get(key);
    if (!poll) {
      poll = { deviceId, requestId, watches: new Set() };
      this.polls.set(key, poll);
    }
    const entry = { afterRevision, onChange };
    poll.watches.add(entry);
    clearTimeout(poll.timer);
    if (!poll.reading) void this.read(key, poll);
    return {
      stop: () => {
        if (poll.watches.delete(entry) && !poll.watches.size) {
          clearTimeout(poll.timer);
          if (!poll.reading) this.polls.delete(key);
        }
      },
    };
  }

  private async read(key: string, poll: Poll): Promise<void> {
    const { deviceId, requestId, watches } = poll;
    // A watch registered during the RPC can first consume the following read.
    const reading = new Set(watches);
    poll.reading = true;
    try {
      const response = await this.devices.runAction(deviceId, "computer.status", { requestId });
      if (!watches.size) return;
      if (!response.ok) throw new Error(`${response.code}: ${response.message}`);
      const status = statusSchema.parse(response.result);
      if (status.requestId !== requestId)
        throw new Error("computer.status returned another request");
      const payload = { ...status, deviceId };
      poll.lastError = undefined;
      for (const entry of reading) {
        if (!watches.has(entry)) continue;
        if (
          status.status === "not_found" ||
          (entry.afterRevision === undefined
            ? status.status !== "pending_consent"
            : status.revision > entry.afterRevision)
        )
          entry.onChange(payload);
      }
    } catch (error) {
      const message = String(error);
      if (watches.size && message !== poll.lastError) {
        poll.lastError = message;
        log.warn("could not read computer.status", { deviceId, requestId, error: message });
      }
    } finally {
      poll.reading = false;
      if (!watches.size) this.polls.delete(key);
      else
        poll.timer = setTimeout(
          () => void this.read(key, poll),
          [...watches].some((watch) => !reading.has(watch)) ? 0 : 2_000,
        ).unref();
    }
  }
}
