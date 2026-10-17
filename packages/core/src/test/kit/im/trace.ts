// What a channel scenario leaves behind for the browser UI in
// packages/channel-test-ui: one trace per test, plus an index of the run. The
// scenario writes the traces, the Rstest reporter writes the index, and the UI
// reads both through these schemas.
import { z } from "zod";

export const TRACE_VERSION = 3;

/** The `task.meta` key under which a test names its trace file. */
export const TRACE_META_KEY = "channelTrace";

const messageSchema = z.object({
  id: z.string(),
  conversation: z.string(),
  from: z.enum(["rome", "user"]),
  text: z.string(),
  replyTo: z.string().optional(),
  edits: z.number().int(),
});

/** A message the moment the platform created or edited it. */
const changeSchema = z.object({
  /** Milliseconds since the scenario started. */
  at: z.number(),
  message: messageSchema,
});

/** One request the platform stand-in received, and its answer. */
const exchangeSchema = z.object({
  method: z.string(),
  path: z.string(),
  requestBody: z.unknown(),
  /** Absent when no answer reached the client by the end of the scenario. */
  status: z.number().int().optional(),
  responseBody: z.unknown().optional(),
  /** Where the answer's shape came from. */
  source: z.enum(["capture", "synthetic", "fault"]).optional(),
  /** The request changed what the platform shows. */
  accepted: z.boolean(),
  /** The client never got the answer: a fault cut it off, or the client was gone. */
  dropped: z.boolean().optional(),
  /** Milliseconds since the scenario started, when the request arrived. A
   *  long poll opened before the scenario arrived at a negative time. */
  receivedAt: z.number(),
  /** When the answer was sent or dropped. Absent while it was still pending. */
  answeredAt: z.number().optional(),
});

/** Something the agent emitted, or something Rome did, at one moment. */
const eventSchema = z.object({
  /** Milliseconds since the scenario started. */
  at: z.number(),
  lane: z.enum(["agent", "rome"]),
  label: z.string(),
  detail: z.unknown().optional(),
});

/** One invariant a scenario checked, and whether it held. */
const checkSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  /** What broke the invariant. */
  detail: z.string().optional(),
});

const stepSchema = z.object({
  label: z.string(),
  status: z.enum(["passed", "failed"]),
  error: z.string().optional(),
  /** Milliseconds since the scenario started. */
  startedAt: z.number(),
  durationMs: z.number(),
  /** What the conversation shows once the step ends. */
  visible: z.array(messageSchema),
});

export const traceSchema = z.object({
  version: z.literal(TRACE_VERSION),
  platform: z.string(),
  /** The conversation the scenario ran in, the one `steps[].visible` shows. */
  conversation: z.string(),
  steps: z.array(stepSchema),
  /** Every request the platform answered after the scenario started, or still
   *  held when it ended, in arrival order. Steps and exchanges share one clock. */
  exchanges: z.array(exchangeSchema),
  /** Every create and edit of a message in the conversation, in the order the
   *  platform applied them. A step's `visible` is the last change of each
   *  message up to the step's end. The browser UI replays these. */
  changes: z.array(changeSchema),
  /** What the agent emitted and what Rome did, as the scenario noted them, on
   *  the same clock as the steps. */
  events: z.array(eventSchema),
  /** The invariants the scenario checked, in the order it checked them. */
  checks: z.array(checkSchema),
});

export const traceIndexSchema = z.object({
  version: z.literal(TRACE_VERSION),
  finishedAt: z.string(),
  tests: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      file: z.string(),
      status: z.enum(["pass", "fail", "skip", "todo"]),
      durationMs: z.number().optional(),
      errors: z.array(z.string()),
      /** The test's trace, relative to the index. Absent for a test that
       *  recorded none. */
      trace: z.string().optional(),
    }),
  ),
});

export type Trace = z.infer<typeof traceSchema>;
export type TraceStep = Trace["steps"][number];
export type TraceExchange = Trace["exchanges"][number];
export type TraceMessage = TraceStep["visible"][number];
export type TraceChange = Trace["changes"][number];
export type TraceEvent = Trace["events"][number];
export type TraceCheck = Trace["checks"][number];
export type TraceIndex = z.infer<typeof traceIndexSchema>;
