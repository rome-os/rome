import type { Trigger } from "../routines/types.js";
import { z } from "zod";
import type { createNodeDevicesService } from "../desktops/node-devices.js";
import type { CatalogEntry } from "../event-catalog.js";
import { createLogger } from "../logger.js";
import type { BusEvent, EventBus } from "./event-bus.js";

const log = createLogger("computer-consent");
export const COMPUTER_CONSENT_EVENT = "computer.consent.changed";
const COMPUTER_CONSENT_SOURCE = "rome-node";
const MAX_WATCH_MS = 10 * 60_000;

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

export type ComputerConsentEvent = BusEvent & {
  name: typeof COMPUTER_CONSENT_EVENT;
  source: typeof COMPUTER_CONSENT_SOURCE;
  payload: z.infer<typeof statusSchema> & { deviceId: string };
};

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
  accepts(event: BusEvent): boolean;
  stop(): void;
}

interface WatchParams {
  deviceId: string;
  requestId: string;
  afterRevision?: number;
}

export function validateConsentWatch(
  trigger: Trigger,
  args: Record<string, unknown>,
  { allowExpired = false } = {},
): { watch?: WatchParams } | { error: string } {
  if (trigger.type !== "event-bus" || trigger.eventName !== COMPUTER_CONSENT_EVENT) return {};
  if (trigger.once !== true || trigger.sourcePattern !== COMPUTER_CONSENT_SOURCE)
    return { error: "computer.consent.changed requires a one-shot trigger from rome-node" };
  const filters = Array.isArray(trigger.filter) ? trigger.filter : [];
  const deviceId = filters.find((c) => c?.field === "deviceId")?.equals;
  const requestId = filters.find((c) => c?.field === "requestId")?.equals;
  if (
    filters.length !== 2 ||
    typeof deviceId !== "string" ||
    !deviceId.trim() ||
    typeof requestId !== "string" ||
    !requestId.trim()
  )
    return { error: "computer.consent.changed requires deviceId and requestId equality filters" };
  const { afterRevision, deadline } = args;
  if (
    afterRevision !== undefined &&
    (typeof afterRevision !== "number" || !Number.isSafeInteger(afterRevision) || afterRevision < 0)
  )
    return { error: "computer.consent.changed requires a nonnegative integer afterRevision" };
  const at = typeof deadline === "string" ? Date.parse(deadline) : NaN;
  const now = Date.now();
  if (!Number.isFinite(at) || at > now + MAX_WATCH_MS)
    return { error: "computer.consent.changed requires a deadline within ten minutes" };
  if (!allowExpired && at <= now)
    return { error: "computer.consent.changed requires a future deadline" };
  return { watch: { deviceId, requestId, afterRevision } };
}

interface Poll {
  deviceId: string;
  requestId: string;
  watches: Set<ConsentWatch>;
  timer?: NodeJS.Timeout;
  reading?: Set<ConsentWatch>;
}

/** Routines for the same request share a read but may have seen different revisions. */
export class ComputerConsentWatcher {
  private readonly polls = new Map<string, Poll>();

  constructor(
    private readonly devices: Pick<ReturnType<typeof createNodeDevicesService>, "runAction">,
    private readonly bus: EventBus,
  ) {}

  watch({ deviceId, requestId, afterRevision }: WatchParams): ConsentWatch {
    const key = JSON.stringify([deviceId, requestId]);
    let poll = this.polls.get(key);
    if (!poll) {
      poll = { deviceId, requestId, watches: new Set() };
      this.polls.set(key, poll);
    }
    const watch: ConsentWatch = {
      accepts: ({ source, payload }) =>
        source === COMPUTER_CONSENT_SOURCE &&
        payload.deviceId === deviceId &&
        payload.requestId === requestId &&
        (!poll.reading || poll.reading.has(watch)) &&
        (payload.status === "not_found" ||
          (typeof afterRevision === "number"
            ? typeof payload.revision === "number" && payload.revision > afterRevision
            : payload.status !== "pending_consent")),
      stop: () => {
        poll.watches.delete(watch);
        if (poll.watches.size === 0) {
          clearTimeout(poll.timer);
          if (!poll.reading) this.polls.delete(key);
        }
      },
    };
    poll.watches.add(watch);
    clearTimeout(poll.timer);
    if (!poll.reading) void this.read(key, poll);
    return watch;
  }

  private async read(key: string, poll: Poll): Promise<void> {
    const { deviceId, requestId, watches } = poll;
    // A watch registered during the RPC can first consume the following read.
    const reading = new Set(watches);
    poll.reading = reading;
    try {
      const response = await this.devices.runAction(deviceId, "computer.status", { requestId });
      if (!watches.size) return;
      if (!response.ok) throw new Error(response.code);
      const status = statusSchema.parse(response.result);
      if (status.requestId !== requestId)
        throw new Error("computer.status returned another request");
      const event: ComputerConsentEvent = {
        name: COMPUTER_CONSENT_EVENT,
        source: COMPUTER_CONSENT_SOURCE,
        emittedAt: new Date().toISOString(),
        payload: { ...status, deviceId },
      };
      if ([...watches].some((watch) => watch.accepts(event))) this.bus.publish(event);
    } catch (error) {
      if (watches.size)
        log.warn("could not read computer.status", { deviceId, requestId, error: String(error) });
    } finally {
      poll.reading = undefined;
      if (!watches.size) this.polls.delete(key);
      else
        poll.timer = setTimeout(
          () => void this.read(key, poll),
          [...watches].some((watch) => !reading.has(watch)) ? 0 : 2_000,
        ).unref();
    }
  }
}
