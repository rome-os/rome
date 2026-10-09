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
import type { Trace, TraceExchange, TraceMessage } from "../src/trace.js";

const LANES: Array<[Lane, string]> = [
  ["test", "Test"],
  ["platform", "Platform API"],
];

/**
 * A trace as a timeline: test steps and the platform's requests on one clock,
 * one row per frame, one column per lane. Selecting a frame shows what the
 * conversation looked like then, and the frame's own detail.
 */
export function TraceView({ trace }: { trace: Trace }) {
  const frames = useMemo(() => framesOf(trace), [trace]);
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(firstInteresting(frames)), [frames]);
  const frame = frames[selected];

  return (
    <div className="trace">
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
                onClick={() => setSelected(index)}
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
        {frame ? (
          <Inspector trace={trace} frame={frame} />
        ) : (
          <p className="muted">No frames recorded.</p>
        )}
      </section>
    </div>
  );
}

function FrameSummary({ frame }: { frame: Frame }) {
  if (frame.kind === "step")
    return <span className={`frame-step ${frame.step.status}`}>{frame.step.label}</span>;
  return <ExchangeSummary exchange={frame.exchange} />;
}

function Inspector({ trace, frame }: { trace: Trace; frame: Frame }) {
  const { after, visible } = visibleAt(trace, frame);
  return (
    <>
      {frame.kind === "step" && frame.step.error && (
        <pre className="error" role="alert">
          {frame.step.error}
        </pre>
      )}
      {frame.kind === "exchange" && <ExchangeDetail exchange={frame.exchange} />}
      <h3>
        {after ? `On the platform after “${after.label}”` : "On the platform before the first step"}
      </h3>
      <Conversation id={trace.conversation} platform={trace.platform} messages={visible} />
    </>
  );
}

function Conversation({
  id,
  platform,
  messages,
}: {
  id: string;
  platform: string;
  messages: TraceMessage[];
}) {
  return (
    <div className="conversation">
      <p className="conversation-id">
        {platform} conversation {id}
      </p>
      {messages.length === 0 ? (
        <p className="muted">No messages yet.</p>
      ) : (
        <ol>
          {messages.map((message) => (
            <li key={message.id} className={`bubble ${message.from}`}>
              {message.replyTo && <span className="bubble-meta">↪ reply to {message.replyTo}</span>}
              <span className="bubble-text">{message.text}</span>
              <span className="bubble-meta">
                #{message.id}
                {message.edits > 0 && ` · edited ${message.edits}×`}
              </span>
            </li>
          ))}
        </ol>
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
