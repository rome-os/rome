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
    <div className="trace">
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
      <div className="trace-side">
        <section className="timeline" aria-label="Timeline">
          <div className="timeline-head" aria-hidden="true">
            <span>ms</span>
            {LANES.map(([lane, label]) => (
              <span key={lane}>{label}</span>
            ))}
          </div>
          <ol>
            {frames.map((item, index) => (
              <li key={key(item, index)}>
                <button
                  type="button"
                  className={`frame${index === selected ? " selected" : ""}`}
                  aria-current={index === selected}
                  onClick={() => select(index)}
                >
                  <span className="frame-time">{item.at.toFixed(1)}</span>
                  {LANES.map(([lane, label]) =>
                    lane === laneOf(item) ? (
                      <span key={lane} className={`frame-cell lane-${lane}`}>
                        <span className="lane-name">{label}</span>
                        <FrameSummary frame={item} />
                      </span>
                    ) : (
                      <span key={lane} className="frame-cell vacant" />
                    ),
                  )}
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section className="inspector" aria-label="Selected frame">
          {frame ? <Detail frame={frame} /> : <p className="muted">No frames recorded.</p>}
        </section>
      </div>
    </div>
  );
}

function FrameSummary({ frame }: { frame: Frame }) {
  if (frame.kind === "step")
    return <span className={`frame-step ${frame.step.status}`}>{frame.step.label}</span>;
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
    <div className="exchange">
      <h3>
        {step.label}{" "}
        <span className={`tag ${step.status === "failed" ? "bad" : "good"}`}>{step.status}</span>
      </h3>
      <p className="muted">
        Started at {step.startedAt.toFixed(1)} ms, took {step.durationMs.toFixed(1)} ms
      </p>
      {step.error && (
        <pre className="error" role="alert">
          {step.error}
        </pre>
      )}
    </div>
  );
}

function ExchangeSummary({ exchange }: { exchange: TraceExchange }) {
  return (
    <span className="frame-exchange">
      <span className="mono" title={describeExchange(exchange)}>
        {abbreviateExchange(exchange)}
      </span>
      <Outcome exchange={exchange} />
    </span>
  );
}

function Outcome({ exchange }: { exchange: TraceExchange }) {
  if (exchange.dropped) return <span className="tag warn">dropped</span>;
  if (exchange.status === undefined) return <span className="tag">pending</span>;
  return (
    <>
      <span className={`tag ${exchange.status >= 400 ? "bad" : ""}`}>{exchange.status}</span>
      {exchange.accepted && <span className="tag good">changed</span>}
    </>
  );
}

function ExchangeDetail({ exchange }: { exchange: TraceExchange }) {
  return (
    <div className="exchange">
      <h3>
        <span className="mono">{describeExchange(exchange)}</span> <Outcome exchange={exchange} />
        {exchange.source && (
          <span className={`tag source-${exchange.source}`} title={SOURCE_HINTS[exchange.source]}>
            {exchange.source}
          </span>
        )}
      </h3>
      <p className="muted">
        Received at {exchange.receivedAt.toFixed(1)} ms
        {exchange.answeredAt !== undefined && `, answered at ${exchange.answeredAt.toFixed(1)} ms`}
      </p>
      <h4>Request</h4>
      <pre>{JSON.stringify(exchange.requestBody, null, 2)}</pre>
      {"responseBody" in exchange && (
        <>
          <h4>Response</h4>
          <pre>{JSON.stringify(exchange.responseBody, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

const SOURCE_HINTS = {
  capture: "Shaped by a recorded, sanitized platform response",
  synthetic: "Hand-written: no capture covers this case yet",
  fault: "Injected by the test",
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
