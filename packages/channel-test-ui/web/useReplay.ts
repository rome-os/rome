import { useCallback, useEffect, useState } from "react";
import type { ReplayPlan } from "../src/replay.js";

/** Where a replay is, in milliseconds from its start. `null` means none is on. */
interface ReplayState {
  time: number;
  playing: boolean;
}

export interface Replay {
  state: ReplayState | null;
  /** Play from the start. */
  start(): void;
  /** Play on from where it paused. */
  resume(): void;
  pause(): void;
  /** Move to `time` and pause there. */
  seek(time: number): void;
  /** End the replay. */
  stop(): void;
}

/** Plays `plan` in real time. The plan decides how long each part takes. */
export function useReplay(plan: ReplayPlan): Replay {
  const [state, setState] = useState<ReplayState | null>(null);
  const { duration } = plan;
  const playing = state?.playing === true;

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const elapsed = now - last;
      last = now;
      setState((current) => {
        if (!current?.playing) return current;
        const time = Math.min(duration, current.time + elapsed);
        return { time, playing: time < duration };
      });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, duration]);

  const start = useCallback(() => setState({ time: 0, playing: true }), []);
  const resume = useCallback(
    () => setState((current) => (current ? { ...current, playing: true } : current)),
    [],
  );
  const pause = useCallback(
    () => setState((current) => (current ? { ...current, playing: false } : current)),
    [],
  );
  const seek = useCallback(
    (time: number) => setState({ time: Math.min(duration, Math.max(0, time)), playing: false }),
    [duration],
  );
  const stop = useCallback(() => setState(null), []);
  return { state, start, resume, pause, seek, stop };
}
