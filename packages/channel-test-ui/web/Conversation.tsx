import { Button } from "@rome-os/ui/button";
import { cn } from "@rome-os/ui/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rome-os/ui/tooltip";
import { Pause, Play, Reply, RotateCcw, Settings, Square } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from "react";
import { stepAt } from "../src/frames.js";
import {
  beatAt,
  type ReplayedMessage,
  type ReplayPlan,
  type ReplaySettings,
  replayAt,
} from "../src/replay.js";
import type { Trace, TraceMessage, TraceStep } from "../src/trace.js";
import { ReplaySettingsDialog } from "./ReplaySettingsDialog.js";
import type { Replay } from "./useReplay.js";

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** An icon-only button. Its label is the accessible name and shows as a tooltip. */
function ToolbarButton({
  label,
  icon,
  ...props
}: { label: string; icon: ReactNode } & Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-md" aria-label={label} {...props}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsWasOpen = useRef(false);
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

  // Radix hands focus back only to a `DialogTrigger`, and this dialog has none,
  // so focus goes back to the button that opened it.
  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen) settingsButton.current?.focus();
    settingsWasOpen.current = settingsOpen;
  }, [settingsOpen]);

  const empty = plan.beats.length === 0;
  const playButton = empty
    ? { label: "No messages to replay", icon: <Play /> }
    : !state
      ? { label: "Replay", icon: <Play /> }
      : state.playing
        ? { label: "Pause", icon: <Pause /> }
        : finished
          ? { label: "Replay again", icon: <RotateCcw /> }
          : { label: "Resume", icon: <Play /> };
  const onPlay = () => {
    if (!state || finished) replay.start();
    else if (state.playing) replay.pause();
    else replay.resume();
  };

  return (
    <section
      aria-label="Conversation"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 min-[1200px]:sticky min-[1200px]:top-0 min-[1200px]:max-h-[calc(100vh-6rem)]"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-ui font-medium text-foreground">Conversation</h3>
          <p className="text-aux text-muted-foreground">
            {trace.platform} conversation {trace.conversation}
          </p>
        </div>
        <div className="flex gap-2">
          <ToolbarButton
            label={playButton.label}
            icon={playButton.icon}
            disabled={empty}
            title={empty ? playButton.label : undefined}
            onClick={onPlay}
          />
          <ToolbarButton
            ref={settingsButton}
            variant="outline"
            label="Settings"
            icon={<Settings />}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      </div>

      <ReplaySettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={onSettings}
        onReset={onResetSettings}
      />

      {state && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="range"
            className="min-w-24 flex-1 accent-primary"
            aria-label="Replay position"
            aria-valuetext={`${seconds(state.time)} of ${seconds(plan.duration)} seconds`}
            min={0}
            max={plan.duration}
            step={1}
            value={state.time}
            onChange={(event) => replay.seek(event.target.valueAsNumber)}
          />
          <span className="font-mono text-aux whitespace-nowrap text-muted-foreground">
            {seconds(state.time)} / {seconds(plan.duration)} s
          </span>
          <Button variant="outline" size="sm" onClick={replay.stop}>
            <Square />
            Stop
          </Button>
        </div>
      )}

      <p className="text-aux text-muted-foreground">
        {state
          ? `Replaying${replayStep ? ` · ${replayStep.label}` : ""}`
          : step
            ? `After “${step.label}”`
            : "Before the first step"}
      </p>

      <div ref={scroller} className="min-h-24 flex-1 overflow-auto max-[1199px]:max-h-[60vh]">
        {shown.length === 0 ? (
          <p className="text-ui text-muted-foreground">No messages yet.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {shown.map(({ message, typing }) => (
              <li
                key={message.id}
                className={cn(
                  "flex max-w-[85%] flex-col rounded-12 px-3 py-1.5",
                  message.from === "rome"
                    ? "self-end bg-primary/10"
                    : "self-start bg-surface-muted",
                )}
              >
                {message.replyTo && (
                  <span className="flex items-center gap-1 text-aux text-muted-foreground">
                    <Reply className="size-3" aria-hidden="true" />
                    reply to {message.replyTo}
                  </span>
                )}
                <span className="max-h-48 overflow-auto text-ui whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {message.text}
                  {typing && (
                    <span
                      aria-hidden="true"
                      className="ml-px inline-block h-[1.1em] w-0.5 translate-y-[0.15em] animate-[caret-blink_1s_steps(2,start)_infinite] bg-current motion-reduce:animate-none"
                    />
                  )}
                </span>
                <span className="text-aux text-muted-foreground">
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
