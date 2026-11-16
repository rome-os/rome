import { Mic, Paperclip, Send, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// Prototype: three ways for the composer to show that the microphone hears
// the guardian while voice input listens. All three cards share one audio
// source, so they move together and compare side by side. The source is the
// real microphone or a simulated voice for a device that has none.

type Source = "off" | "asking" | "microphone" | "simulated" | "refused";

type LevelListener = (level: number) => void;

/** Loudness in 0..1, read about 60 times a second, from the microphone or a simulated voice. */
function useAudioLevel() {
  const [source, setSource] = useState<Source>("off");
  const listeners = useRef(new Set<LevelListener>());
  const stopRef = useRef<(() => void) | null>(null);

  const subscribe = useCallback((listener: LevelListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const emit = useCallback((level: number) => {
    for (const listener of listeners.current) listener(level);
  }, []);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    emit(0);
    setSource("off");
  }, [emit]);

  // Rises fast and falls slowly, so a syllable shows at once and the motion
  // does not flicker between them.
  const run = useCallback(
    (read: () => number) => {
      let frame = 0;
      let smooth = 0;
      const tick = () => {
        const raw = read();
        smooth += (raw - smooth) * (raw > smooth ? 0.5 : 0.12);
        emit(smooth);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    },
    [emit],
  );

  const startMicrophone = useCallback(async () => {
    stopRef.current?.();
    setSource("asking");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setSource("refused");
      return;
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const cancel = run(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const rms = Math.sqrt(sum / samples.length);
      // -55 dBFS (a quiet room) maps to 0, -10 dBFS (close, loud speech) to 1.
      const db = 20 * Math.log10(rms || 1e-8);
      return Math.max(0, Math.min(1, (db + 55) / 45));
    });
    stopRef.current = () => {
      cancel();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    };
    setSource("microphone");
  }, [run]);

  const startSimulated = useCallback(() => {
    stopRef.current?.();
    const started = performance.now();
    // Syllables at about 4 a second, grouped into words, with pauses between phrases.
    const cancel = run(() => {
      const t = (performance.now() - started) / 1000;
      const phrase = (Math.sin(t * 0.7) + Math.sin(t * 1.3 + 1)) / 2;
      if (phrase < -0.35) return Math.random() * 0.04;
      const syllable = Math.max(0, Math.sin(t * Math.PI * 4.2) * Math.sin(t * 2.1 + 0.4));
      return Math.min(1, 0.15 + syllable * (0.55 + 0.3 * Math.random()));
    });
    stopRef.current = cancel;
    setSource("simulated");
  }, [run]);

  useEffect(() => () => stopRef.current?.(), []);

  return { source, subscribe, startMicrophone, startSimulated, stop };
}

type Subscribe = (listener: LevelListener) => () => void;

/** Runs `onLevel` on each reading without re-rendering. */
function useLevel(subscribe: Subscribe, onLevel: LevelListener) {
  const latest = useRef(onLevel);
  latest.current = onLevel;
  useEffect(() => subscribe((level) => latest.current(level)), [subscribe]);
}

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// --- Variant A: a ring around the stop button that breathes while listening and swells with the voice ---

const BREATH_PERIOD_S = 1.8;

function PulseButton({ subscribe, onStop }: { subscribe: Subscribe; onStop: () => void }) {
  const ring = useRef<HTMLSpanElement>(null);
  useLevel(subscribe, (level) => {
    const el = ring.current;
    if (!el) return;
    if (reducedMotion()) {
      el.style.opacity = String(level > 0.15 ? 0.45 : 0.2);
      el.style.transform = "scale(1.25)";
      return;
    }
    // The breath runs in silence too, so the ring says "listening" before any
    // sound arrives. The voice swells it on top, and the breath fades as the
    // voice takes over so the two do not fight.
    const t = performance.now() / 1000;
    const breath = (1 - Math.cos((t / BREATH_PERIOD_S) * 2 * Math.PI)) / 2;
    const calm = 1 - Math.min(1, level * 1.5);
    el.style.opacity = String(0.12 + breath * 0.18 * calm + level * 0.4);
    el.style.transform = `scale(${1.06 + breath * 0.22 * calm + level * 0.5})`;
  });
  return (
    <span className="relative inline-flex">
      <span
        ref={ring}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[var(--control-r-sm)] bg-primary"
        style={{ opacity: 0.15, transform: "scale(1)" }}
      />
      <StopButton onStop={onStop} />
    </span>
  );
}

// --- Variant B: a five-bar meter beside the stop button ---

const BAR_WEIGHTS = [0.45, 0.75, 1, 0.75, 0.45];

function MeterBars({ subscribe }: { subscribe: Subscribe }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useLevel(subscribe, (level) => {
    const t = performance.now() / 1000;
    bars.current.forEach((el, i) => {
      if (!el) return;
      // A little independent wobble per bar, so the meter reads as sound, not a gauge.
      const wobble = reducedMotion() ? 1 : 0.8 + 0.2 * Math.sin(t * 9 + i * 1.7);
      const height = 0.18 + 0.82 * level * (BAR_WEIGHTS[i] ?? 1) * wobble;
      el.style.transform = `scaleY(${Math.min(1, height)})`;
    });
  });
  return (
    <span aria-hidden className="flex h-4 items-center gap-[3px] px-1">
      {BAR_WEIGHTS.map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="h-full w-[3px] rounded-full bg-primary transition-transform duration-75"
          style={{ transform: "scaleY(0.18)" }}
        />
      ))}
    </span>
  );
}

// --- Variant C: a scrolling waveform across the toolbar ---

const WAVE_STEP_MS = 50;
const WAVE_BAR = 3;
const WAVE_GAP = 2;

function Waveform({ subscribe }: { subscribe: Subscribe }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<number[]>([]);
  const lastPush = useRef(0);
  const peak = useRef(0);
  useLevel(subscribe, (level) => {
    const el = canvas.current;
    if (!el) return;
    peak.current = Math.max(peak.current, level);
    const now = performance.now();
    if (now - lastPush.current < WAVE_STEP_MS) return;
    lastPush.current = now;
    history.current.push(peak.current);
    peak.current = 0;
    const dpr = window.devicePixelRatio || 1;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (el.width !== width * dpr || el.height !== height * dpr) {
      el.width = width * dpr;
      el.height = height * dpr;
    }
    const capacity = Math.ceil(width / (WAVE_BAR + WAVE_GAP));
    if (history.current.length > capacity)
      history.current.splice(0, history.current.length - capacity);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(el).color;
    const values = history.current;
    for (let i = 0; i < values.length; i++) {
      const v = values[values.length - 1 - i] ?? 0;
      const h = Math.max(2, v * height);
      const x = width - (i + 1) * (WAVE_BAR + WAVE_GAP);
      if (x < 0) break;
      // Older bars fade toward the left edge.
      ctx.globalAlpha = Math.max(0.25, 1 - (i / capacity) * 0.75);
      ctx.beginPath();
      ctx.roundRect(x, (height - h) / 2, WAVE_BAR, h, WAVE_BAR / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
  return <canvas ref={canvas} aria-hidden className="h-7 w-full min-w-0 text-primary" />;
}

// --- The composer frame the three variants sit in ---

function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <Button
      type="button"
      variant="default"
      size="icon-sm"
      aria-pressed
      aria-label="Stop voice input"
      title="Stop voice input"
      onClick={onStop}
      className="relative touch-target"
    >
      <Square aria-hidden className="fill-current" />
    </Button>
  );
}

function MicButton({ onStart }: { onStart: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-pressed={false}
      aria-label="Start voice input"
      title="Start voice input"
      onClick={onStart}
      className="touch-target"
    >
      <Mic aria-hidden />
    </Button>
  );
}

function ComposerFrame({
  listening,
  toolbar,
  voiceControl,
  onStart,
}: {
  listening: boolean;
  /** Replaces the left of the toolbar while listening. */
  toolbar?: React.ReactNode;
  voiceControl: React.ReactNode;
  onStart: () => void;
}) {
  return (
    <div className="rounded-16 border border-border bg-muted px-4 py-3">
      <div className="min-h-12 text-composer text-subtle-foreground">
        {listening ? "Listening…" : "Message the concierge"}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {listening && toolbar ? (
            toolbar
          ) : (
            <Button variant="ghost" size="icon-sm" aria-label="Attach" className="touch-target">
              <Paperclip aria-hidden />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {listening ? voiceControl : <MicButton onStart={onStart} />}
          <Button variant="default" size="icon-sm" aria-label="Send" className="touch-target">
            <Send aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Variant({
  letter,
  name,
  description,
  children,
}: {
  letter: string;
  name: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-ui font-medium text-foreground">
          {letter}. {name}
        </h2>
        <p className="text-aux text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export default function VoiceLevelPage() {
  const audio = useAudioLevel();
  const listening = audio.source === "microphone" || audio.source === "simulated";
  const start = () => void audio.startMicrophone();
  const stop = audio.stop;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-8">
        <header className="flex flex-col gap-3">
          <h1 className="text-title font-semibold">
            Voice input: showing the microphone hears you
          </h1>
          <p className="text-ui text-muted-foreground">
            Press the microphone in any composer, or one of the buttons below, then speak. All three
            move together from the same audio, so you can compare them. With reduced motion turned
            on, A and B change in steps instead of moving smoothly.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={start} disabled={audio.source === "microphone"}>
              <Mic aria-hidden /> Use my microphone
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={audio.startSimulated}
              disabled={audio.source === "simulated"}
            >
              Simulate a voice
            </Button>
            <Button size="sm" variant="ghost" onClick={stop} disabled={!listening}>
              Stop
            </Button>
            <span className="text-aux text-muted-foreground">
              {
                {
                  off: "Not listening",
                  asking: "Waiting for microphone permission…",
                  microphone: "Listening to your microphone",
                  simulated: "Playing a simulated voice",
                  refused: "The browser refused the microphone. Try “Simulate a voice”.",
                }[audio.source]
              }
            </span>
          </div>
        </header>

        <Variant
          letter="A"
          name="Pulse"
          description="A soft ring behind the stop button breathes slowly while listening, even in silence, and swells when you speak."
        >
          <ComposerFrame
            listening={listening}
            onStart={start}
            voiceControl={<PulseButton subscribe={audio.subscribe} onStop={stop} />}
          />
        </Variant>

        <Variant
          letter="B"
          name="Level meter"
          description="Five small bars beside the stop button rise and fall with your voice."
        >
          <ComposerFrame
            listening={listening}
            onStart={start}
            voiceControl={
              <span className="flex items-center gap-1">
                <MeterBars subscribe={audio.subscribe} />
                <StopButton onStop={stop} />
              </span>
            }
          />
        </Variant>

        <Variant
          letter="C"
          name="Waveform"
          description="While listening, the toolbar becomes a waveform of the last few seconds, scrolling in from the right."
        >
          <ComposerFrame
            listening={listening}
            onStart={start}
            toolbar={<Waveform subscribe={audio.subscribe} />}
            voiceControl={<StopButton onStop={stop} />}
          />
        </Variant>
      </div>
    </div>
  );
}
