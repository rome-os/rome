import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// Prototype: ways the heard words can arrive in the message field. The
// dictation socket sends `settled` text, which never changes, and `pending`
// text, the provider's current guess at the last words, which it may revise.
// A simulated transcriber replays that shape at speaking pace so every
// variant gets the same updates.
//
// The real field is a textarea, which cannot style parts of its text, so any
// variant past "Today" needs a styled copy of the text drawn over the field
// while listening.

type Heard = { settled: string; pending: string };

const SAMPLES = {
  en: {
    units:
      "Can you move my Thursday meeting with Dana to Friday afternoon and tell the team in the project chat".split(
        " ",
      ),
    // A wrong first guess for some words, revised a moment later.
    guesses: { Thursday: "Thirsty", Dana: "Donna", afternoon: "after", chat: "chap" } as Record<
      string,
      string
    >,
    join: " ",
  },
  zh: {
    units: Array.from("帮我把周四和小王的会议改到周五下午，然后在项目群里通知大家"),
    guesses: { 周: "州", 议: "义", 午: "五", 知: "之" } as Record<string, string>,
    join: "",
  },
} as const;

type Language = keyof typeof SAMPLES;

/** Replays a transcriber: words arrive a few at a time, the last ones pending, some revised. */
function useSimulatedTranscriber(language: Language) {
  const [heard, setHeard] = useState<Heard>({ settled: "", pending: "" });
  const [running, setRunning] = useState(false);
  const timer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setRunning(false);
  }, []);

  const play = useCallback(() => {
    stop();
    const { units, guesses, join } = SAMPLES[language];
    let settledCount = 0;
    let heardCount = 0;
    let guessing = false;
    const text = (from: number, to: number, lastGuess: boolean) =>
      units
        .slice(from, to)
        .map((unit, i) => (lastGuess && from + i === to - 1 ? (guesses[unit] ?? unit) : unit))
        .join(join);
    const step = () => {
      if (guessing) {
        guessing = false;
      } else if (heardCount < units.length) {
        heardCount += 1;
        guessing = units[heardCount - 1] in guesses;
      }
      // The provider settles all but the last two or three units.
      const keepPending = heardCount < units.length ? 2 + Math.round(Math.random()) : 0;
      if (!guessing) settledCount = Math.max(settledCount, heardCount - keepPending);
      const settled = text(0, settledCount, false);
      const pendingText = text(settledCount, heardCount, guessing);
      setHeard({
        settled: settled + (settled && pendingText && join ? join : ""),
        pending: pendingText,
      });
      if (settledCount === units.length) {
        timer.current = null;
        setRunning(false);
        return;
      }
      timer.current = window.setTimeout(step, 140 + Math.random() * 220);
    };
    setHeard({ settled: "", pending: "" });
    setRunning(true);
    timer.current = window.setTimeout(step, 300);
  }, [language, stop]);

  useEffect(() => stop, [stop]);
  return { heard, running, play, stop };
}

/** Splits text into words and the spaces after them, or into characters for Chinese. */
function units(text: string, language: Language): string[] {
  if (language === "zh") return Array.from(text);
  return text.match(/\S+\s*/g) ?? [];
}

// --- Today: the text replaces itself at each update ---

function Plain({ heard }: { heard: Heard }) {
  return (
    <>
      {heard.settled}
      {heard.pending}
    </>
  );
}

// --- Tunable: every knob of the fade, plus presets ---

type PendingLook = "same" | "dim" | "hide";

interface Fade {
  /** 0 turns the fade off. */
  durationMs: number;
  /** Where the fade starts, from 0 (invisible) to 1 (no fade). */
  fromOpacity: number;
  blurPx: number;
  /** How words the transcriber may still change look. "hide" shows each word once it is final. */
  pending: PendingLook;
  /** Whether a word the transcriber corrects fades in again. */
  refadeCorrections: boolean;
  /** Extra delay per word within one update. 0 fades the update's words together. */
  staggerMs: number;
}

const PRESETS: { name: string; description: string; fade: Fade }[] = [
  {
    name: "Mist",
    description: "Last round's A2, for reference. Corrections fade in again.",
    fade: {
      durationMs: 800,
      fromOpacity: 0.15,
      blurPx: 1.5,
      pending: "same",
      refadeCorrections: true,
      staggerMs: 0,
    },
  },
  {
    name: "Calm",
    description:
      "A short, shallow fade once per word. Corrections swap in place, and words that may change sit dimmed.",
    fade: {
      durationMs: 300,
      fromOpacity: 0.5,
      blurPx: 0,
      pending: "dim",
      refadeCorrections: false,
      staggerMs: 0,
    },
  },
  {
    name: "Final only",
    description:
      "Words appear only once they are final, fading in together. Nothing ever changes after it shows, at the cost of lagging a word or two.",
    fade: {
      durationMs: 400,
      fromOpacity: 0,
      blurPx: 0,
      pending: "hide",
      refadeCorrections: false,
      staggerMs: 0,
    },
  },
  {
    name: "Still",
    description: "No fade at all. Words that may change sit dimmed and darken quietly when final.",
    fade: {
      durationMs: 0,
      fromOpacity: 1,
      blurPx: 0,
      pending: "dim",
      refadeCorrections: false,
      staggerMs: 0,
    },
  },
  {
    name: "Ripple",
    description: "Each update's new words fade in one after another, 40 ms apart.",
    fade: {
      durationMs: 350,
      fromOpacity: 0.2,
      blurPx: 0,
      pending: "same",
      refadeCorrections: false,
      staggerMs: 40,
    },
  },
];

function Tuned({ heard, language, fade }: { heard: Heard; language: Language; fade: Fade }) {
  const settled = units(heard.settled, language);
  const pending = fade.pending === "hide" ? [] : units(heard.pending, language);
  // The delay each word got when it first showed, so a later update never
  // restarts a fade that is under way.
  const delays = useRef(new Map<string, number>());
  const shownBefore = useRef(0);
  const firstNew = shownBefore.current;
  const all = [...settled, ...pending];
  const keyOf = (unit: string, i: number) =>
    fade.refadeCorrections ? `${i}:${unit.trim()}` : String(i);
  const view = all.map((unit, i) => {
    const key = keyOf(unit, i);
    let delay = delays.current.get(key);
    if (delay === undefined) {
      delay = Math.max(0, i - firstNew) * fade.staggerMs;
      delays.current.set(key, delay);
    }
    const isPending = i >= settled.length;
    return (
      <span
        key={key}
        className="transition-colors"
        style={{
          transitionDuration: `${Math.max(fade.durationMs, 200)}ms`,
          color:
            isPending && fade.pending === "dim"
              ? "var(--color-subtle-foreground)"
              : "var(--color-foreground)",
          animation:
            fade.durationMs > 0
              ? `voice-text-tuned-in ${fade.durationMs}ms cubic-bezier(0.25, 0.1, 0.25, 1) ${delay}ms both`
              : undefined,
          ["--voice-from-opacity" as string]: String(fade.fromOpacity),
          ["--voice-from-blur" as string]: `${fade.blurPx}px`,
        }}
      >
        {unit}
      </span>
    );
  });
  shownBefore.current = all.length;
  if (all.length === 0) delays.current.clear();
  return <>{view}</>;
}

const STYLES = `
@keyframes voice-text-tuned-in {
  from { opacity: var(--voice-from-opacity); filter: blur(var(--voice-from-blur)); }
  to { opacity: 1; filter: blur(0); }
}
@media (prefers-reduced-motion: reduce) {
  [style*="voice-text-tuned-in"] { animation: none !important; }
}
`;

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-aux text-muted-foreground">
      <span className="w-36 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 flex-1 accent-[var(--color-primary)]"
      />
      <span className="w-16 shrink-0 text-right tabular-nums text-foreground">
        {value}
        {unit}
      </span>
    </label>
  );
}

function Choice<T extends string | boolean>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-aux text-muted-foreground">
      <span className="w-36 shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <Button
            key={String(option.value)}
            size="xs"
            variant={option.value === value ? "secondary" : "ghost"}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Field({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-24 rounded-16 border border-border bg-muted px-4 py-3 text-composer text-foreground">
      {children}
    </div>
  );
}

export function VoiceTextStreaming() {
  const [language, setLanguage] = useState<Language>("en");
  const transcriber = useSimulatedTranscriber(language);
  const { play } = transcriber;
  const [fade, setFade] = useState<Fade>(PRESETS[1]!.fade);
  const [preset, setPreset] = useState<string | null>(PRESETS[1]!.name);
  const tune = (next: Partial<Fade>) => {
    setFade((current) => ({ ...current, ...next }));
    setPreset(null);
  };
  // Starts once on open and again whenever the language changes.
  useEffect(() => {
    play();
  }, [play]);
  // Each new setting replays the words, so the fade is seen from the start.
  useEffect(() => {
    play();
  }, [fade, play]);

  return (
    <section className="flex flex-col gap-6">
      <style>{STYLES}</style>
      <header className="flex flex-col gap-3">
        <h2 className="text-title font-semibold">Transcribed text arriving: tune the fade</h2>
        <p className="text-ui text-muted-foreground">
          A simulated transcriber sends words at speaking pace, including corrections, the way a
          real one does. Pick a preset or move the controls; each change replays the words.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={transcriber.play}>
            {transcriber.running ? "Restart" : "Play again"}
          </Button>
          <Button
            size="sm"
            variant={language === "en" ? "secondary" : "ghost"}
            onClick={() => setLanguage("en")}
          >
            English
          </Button>
          <Button
            size="sm"
            variant={language === "zh" ? "secondary" : "ghost"}
            onClick={() => setLanguage("zh")}
          >
            中文
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-2">
        <h3 className="text-ui font-medium text-foreground">Presets</h3>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((option) => (
            <Button
              key={option.name}
              size="sm"
              variant={preset === option.name ? "default" : "outline"}
              onClick={() => {
                setFade(option.fade);
                setPreset(option.name);
              }}
            >
              {option.name}
            </Button>
          ))}
        </div>
        <p className="text-aux text-muted-foreground">
          {PRESETS.find((option) => option.name === preset)?.description ?? "Your own settings."}
        </p>
      </div>

      <Field>
        <Tuned
          key={JSON.stringify(fade)}
          heard={transcriber.heard}
          language={language}
          fade={fade}
        />
      </Field>

      <div className="flex flex-col gap-3 rounded-16 border border-border px-4 py-3">
        <Slider
          label="Fade length"
          value={fade.durationMs}
          min={0}
          max={1500}
          step={50}
          unit=" ms"
          onChange={(durationMs) => tune({ durationMs })}
        />
        <Slider
          label="Starting opacity"
          value={fade.fromOpacity}
          min={0}
          max={1}
          step={0.05}
          unit=""
          onChange={(fromOpacity) => tune({ fromOpacity })}
        />
        <Slider
          label="Starting blur"
          value={fade.blurPx}
          min={0}
          max={4}
          step={0.25}
          unit=" px"
          onChange={(blurPx) => tune({ blurPx })}
        />
        <Slider
          label="Delay between words"
          value={fade.staggerMs}
          min={0}
          max={120}
          step={10}
          unit=" ms"
          onChange={(staggerMs) => tune({ staggerMs })}
        />
        <Choice
          label="Words that may change"
          value={fade.pending}
          options={[
            { value: "same", label: "Look final" },
            { value: "dim", label: "Dimmed" },
            { value: "hide", label: "Hidden until final" },
          ]}
          onChange={(pending) => tune({ pending })}
        />
        <Choice
          label="A corrected word"
          value={fade.refadeCorrections}
          options={[
            { value: false, label: "Swaps in place" },
            { value: true, label: "Fades in again" },
          ]}
          onChange={(refadeCorrections) => tune({ refadeCorrections })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-ui font-medium text-foreground">Today, for comparison</h3>
        <Field>
          <Plain heard={transcriber.heard} />
        </Field>
      </div>
    </section>
  );
}
