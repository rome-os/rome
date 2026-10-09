import { useEffect, useId, useRef, useState } from "react";
import { stepAt } from "../src/frames.js";
import {
  beatAt,
  type ReplayedMessage,
  type ReplayPlan,
  type ReplaySettings,
  replayAt,
} from "../src/replay.js";
import type { Trace, TraceMessage, TraceStep } from "../src/trace.js";
import { ReplaySettingsPanel } from "./ReplaySettingsPanel.js";
import type { Replay } from "./useReplay.js";

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/**
 * The conversation as the user sees it. Without a replay it shows what the
 * selected step left on the platform. A replay plays the recorded changes from
 * the start, at the pace the settings give.
 */
export function Conversation({
  trace,
  plan,
  replay,
  step,
  messages,
  settings,
  onSettings,
  onResetSettings,
}: {
  trace: Trace;
  plan: ReplayPlan;
  replay: Replay;
  /** The step whose result `messages` shows. */
  step?: TraceStep;
  messages: TraceMessage[];
  settings: ReplaySettings;
  onSettings: (next: ReplaySettings) => void;
  onResetSettings: () => void;
}) {
  const settingsId = useId();
  const [configuring, setConfiguring] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const { state } = replay;

  const shown: ReplayedMessage[] = state
    ? replayAt(plan, state.time)
    : messages.map((message) => ({ message, typing: false }));
  const finished = state !== null && state.time >= plan.duration;
  const beat = state ? beatAt(plan, state.time) : undefined;
  const replayStep = beat ? stepAt(trace, beat.at) : undefined;

  // A replay follows the newest message as it appears and grows.
  useEffect(() => {
    const element = scroller.current;
    if (state && shown.length > 0 && element) element.scrollTop = element.scrollHeight;
  }, [state, shown]);

  const playLabel = !state
    ? "▶ Replay"
    : state.playing
      ? "⏸ Pause"
      : finished
        ? "↻ Replay again"
        : "▶ Resume";
  const onPlay = () => {
    if (!state || finished) replay.start();
    else if (state.playing) replay.pause();
    else replay.resume();
  };

  return (
    <section className="conversation" aria-label="Conversation">
      <div className="conversation-head">
        <div>
          <h3>Conversation</h3>
          <p className="conversation-id">
            {trace.platform} conversation {trace.conversation}
          </p>
        </div>
        <button
          type="button"
          className="button"
          aria-expanded={configuring}
          aria-controls={settingsId}
          onClick={() => setConfiguring(!configuring)}
        >
          ⚙ Settings
        </button>
      </div>

      {configuring && (
        <ReplaySettingsPanel
          id={settingsId}
          settings={settings}
          onChange={onSettings}
          onReset={onResetSettings}
        />
      )}

      <div className="replay-bar">
        <button
          type="button"
          className="primary"
          disabled={plan.beats.length === 0}
          title={plan.beats.length === 0 ? "This trace recorded no messages" : undefined}
          onClick={onPlay}
        >
          {playLabel}
        </button>
        {state && (
          <>
            <input
              type="range"
              className="replay-position"
              aria-label="Replay position"
              aria-valuetext={`${seconds(state.time)} of ${seconds(plan.duration)} seconds`}
              min={0}
              max={plan.duration}
              step={1}
              value={state.time}
              onChange={(event) => replay.seek(event.target.valueAsNumber)}
            />
            <span className="replay-time mono">
              {seconds(state.time)} / {seconds(plan.duration)} s
            </span>
            <button type="button" className="button" onClick={replay.stop}>
              ■ Stop
            </button>
          </>
        )}
      </div>

      <p className="muted conversation-step">
        {state
          ? `Replaying${replayStep ? ` · ${replayStep.label}` : ""}`
          : step
            ? `After “${step.label}”`
            : "Before the first step"}
      </p>

      <div className="conversation-scroll" ref={scroller}>
        {shown.length === 0 ? (
          <p className="muted">No messages yet.</p>
        ) : (
          <ol>
            {shown.map(({ message, typing }) => (
              <li key={message.id} className={`bubble ${message.from}${typing ? " typing" : ""}`}>
                {message.replyTo && (
                  <span className="bubble-meta">↪ reply to {message.replyTo}</span>
                )}
                <span className="bubble-text">
                  {message.text}
                  {typing && <span className="caret" aria-hidden="true" />}
                </span>
                <span className="bubble-meta">
                  #{message.id}
                  {message.edits > 0 && ` · edited ${message.edits}×`}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
