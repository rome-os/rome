import { Alert, AlertDescription } from "@rome-os/ui/alert";
import { Badge } from "@rome-os/ui/badge";
import { Card, CardContent } from "@rome-os/ui/card";
import { cn } from "@rome-os/ui/cn";
import { List, ListRow } from "@rome-os/ui/list-row";
import { useEffect, useMemo, useState } from "react";
import {
  abbreviateExchange,
  describeExchange,
  type Frame,
  framesOf,
  type Lane,
  laneOf,
  visibleAt,
} from "../src/frames.js";
import { planReplay } from "../src/replay.js";
import type { Trace, TraceExchange, TraceStep } from "../src/trace.js";
import { Conversation } from "./Conversation.js";
import { useReplay } from "./useReplay.js";
import { useReplaySettings } from "./useReplaySettings.js";

const LANES: Array<[Lane, string]> = [
  ["test", "Test"],
  ["platform", "Platform API"],
];

// A frame's columns: the time, then the test lane and the platform lane. A
// narrow screen keeps one lane column and names each row's lane inline.
const FRAME_GRID =
  "grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[3rem_minmax(0,1fr)_minmax(0,1.4fr)]";

const CODE = "max-h-72 overflow-auto rounded-8 bg-surface-muted p-3 font-mono text-aux";

/**
 * A trace in three parts. The conversation, which can be replayed, sits in the
 * middle. On the right, the timeline lists the test's steps and the platform's
 * requests on one clock, and the selected frame's detail sits below it.
 * Selecting a frame ends a replay and shows what the conversation looked like
 * after that frame's step.
 */
export function TraceView({ trace }: { trace: Trace }) {
  const frames = useMemo(() => framesOf(trace), [trace]);
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(firstInteresting(frames)), [frames]);
  const frame = frames[selected];

  const { settings, update, reset } = useReplaySettings();
  const plan = useMemo(() => planReplay(trace.changes, settings), [trace.changes, settings]);
  const replay = useReplay(plan);
  const { stop } = replay;
  const select = (index: number) => {
    setSelected(index);
    stop();
  };
  const { after, visible } = frame ? visibleAt(trace, frame) : { visible: [] };

  return (
    <div className="grid items-start gap-4 min-[1200px]:grid-cols-[minmax(280px,1fr)_minmax(440px,1.3fr)]">
      <Conversation
        trace={trace}
        plan={plan}
        replay={replay}
        step={after}
        messages={visible}
        settings={settings}
        onSettings={update}
        onResetSettings={reset}
      />
      <div className="flex min-w-0 flex-col gap-4">
        <Card role="region" aria-label="Timeline" className="max-h-[45vh] gap-0 overflow-auto py-0">
          <div
            aria-hidden="true"
            className={cn(
              FRAME_GRID,
              "border-b border-border px-3 py-2 text-aux text-muted-foreground max-sm:hidden",
            )}
          >
            <span>ms</span>
            {LANES.map(([lane, label]) => (
              <span key={lane}>{label}</span>
            ))}
          </div>
          <List asChild>
            <ol>
              {frames.map((item, index) => (
                <li key={key(item, index)}>
                  <ListRow
                    asChild
                    interactive
                    size="sm"
                    selected={index === selected}
                    className={FRAME_GRID}
                  >
                    <button
                      type="button"
                      aria-current={index === selected}
                      onClick={() => select(index)}
                    >
                      <span className="text-right font-mono text-aux text-muted-foreground">
                        {item.at.toFixed(1)}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 [overflow-wrap:anywhere]",
                          laneOf(item) === "platform"
                            ? "col-start-2 sm:col-start-3"
                            : "col-start-2",
                        )}
                      >
                        <span className="mr-1.5 text-aux text-muted-foreground sm:hidden">
                          {LANES.find(([lane]) => lane === laneOf(item))?.[1]}
                        </span>
                        <FrameSummary frame={item} />
                      </span>
                    </button>
                  </ListRow>
                </li>
              ))}
            </ol>
          </List>
        </Card>
        <Card role="region" aria-label="Selected frame">
          <CardContent className="flex flex-col gap-2">
            {frame ? (
              <Detail frame={frame} />
            ) : (
              <p className="text-ui text-muted-foreground">No frames recorded.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FrameSummary({ frame }: { frame: Frame }) {
  if (frame.kind === "step")
    return (
      <span
        className={cn(
          "border-l-[3px] pl-2",
          frame.step.status === "failed"
            ? "border-destructive text-destructive-fg"
            : "border-success",
        )}
      >
        {frame.step.label}
      </span>
    );
  return <ExchangeSummary exchange={frame.exchange} />;
}

function Detail({ frame }: { frame: Frame }) {
  return frame.kind === "step" ? (
    <StepDetail step={frame.step} />
  ) : (
    <ExchangeDetail exchange={frame.exchange} />
  );
}

function StepDetail({ step }: { step: TraceStep }) {
  return (
    <>
      <h3 className="flex flex-wrap items-center gap-1.5 text-ui font-medium text-foreground">
        {step.label}
        <Badge variant={step.status === "failed" ? "destructive" : "success"}>{step.status}</Badge>
      </h3>
      <p className="text-ui text-muted-foreground">
        Started at {step.startedAt.toFixed(1)} ms, took {step.durationMs.toFixed(1)} ms
      </p>
      {step.error && (
        <Alert variant="destructive">
          <AlertDescription className="font-mono text-aux whitespace-pre-wrap">
            {step.error}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

function ExchangeSummary({ exchange }: { exchange: TraceExchange }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="font-mono text-aux" title={describeExchange(exchange)}>
        {abbreviateExchange(exchange)}
      </span>
      <Outcome exchange={exchange} />
    </span>
  );
}

function Outcome({ exchange }: { exchange: TraceExchange }) {
  if (exchange.dropped) return <Badge variant="warning">dropped</Badge>;
  if (exchange.status === undefined) return <Badge variant="muted">pending</Badge>;
  return (
    <>
      <Badge variant={exchange.status >= 400 ? "destructive" : "outline"}>{exchange.status}</Badge>
      {exchange.accepted && <Badge variant="success">changed</Badge>}
    </>
  );
}

function ExchangeDetail({ exchange }: { exchange: TraceExchange }) {
  return (
    <>
      <h3 className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-aux font-medium text-foreground">
          {describeExchange(exchange)}
        </span>
        <Outcome exchange={exchange} />
        {exchange.source && (
          <Badge variant={SOURCE_VARIANTS[exchange.source]} title={SOURCE_HINTS[exchange.source]}>
            {exchange.source}
          </Badge>
        )}
      </h3>
      <p className="text-ui text-muted-foreground">
        Received at {exchange.receivedAt.toFixed(1)} ms
        {exchange.answeredAt !== undefined && `, answered at ${exchange.answeredAt.toFixed(1)} ms`}
      </p>
      <h4 className="text-aux text-muted-foreground">Request</h4>
      <pre className={CODE}>{JSON.stringify(exchange.requestBody, null, 2)}</pre>
      {"responseBody" in exchange && (
        <>
          <h4 className="text-aux text-muted-foreground">Response</h4>
          <pre className={CODE}>{JSON.stringify(exchange.responseBody, null, 2)}</pre>
        </>
      )}
    </>
  );
}

const SOURCE_HINTS = {
  capture: "Shaped by a recorded, sanitized platform response",
  synthetic: "Hand-written: no capture covers this case yet",
  fault: "Injected by the test",
} as const;

const SOURCE_VARIANTS = {
  capture: "info",
  synthetic: "warning",
  fault: "outline",
} as const;

/** The first failed step, else the first platform write, else the first frame. */
function firstInteresting(frames: Frame[]): number {
  const failed = frames.findIndex((f) => f.kind === "step" && f.step.status === "failed");
  if (failed >= 0) return failed;
  const write = frames.findIndex((f) => f.kind === "exchange" && f.exchange.accepted);
  return Math.max(write, 0);
}

function key(frame: Frame, index: number): string {
  return `${frame.kind}-${index}`;
}
