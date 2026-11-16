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

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
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

// --- A: each new word fades and sharpens in ---

function FadeIn({ heard, language }: { heard: Heard; language: Language }) {
  const all = units(heard.settled + heard.pending, language);
  return (
    <>
      {all.map((unit, i) => (
        // The key changes when a guess is revised, so the corrected word fades in again.
        <span key={`${i}:${unit.trim()}`} className="voice-text-fade">
          {unit}
        </span>
      ))}
    </>
  );
}

// --- B: the words still being worked out show dimmed, and darken as they settle ---

function DimPending({ heard, language }: { heard: Heard; language: Language }) {
  const settled = units(heard.settled, language);
  const pending = units(heard.pending, language);
  return (
    <>
      {settled.map((unit, i) => (
        <span key={i} className="transition-colors duration-300 text-foreground">
          {unit}
        </span>
      ))}
      {pending.map((unit, i) => (
        <span
          key={settled.length + i}
          className="transition-colors duration-300 text-subtle-foreground"
        >
          {unit}
        </span>
      ))}
    </>
  );
}

// --- C: the text types itself out at an even pace, whatever pace it arrives at ---

function Typewriter({ heard }: { heard: Heard }) {
  const target = heard.settled + heard.pending;
  const [shown, setShown] = useState("");
  const targetRef = useRef(target);
  targetRef.current = target;
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let budget = 0;
    const tick = (now: number) => {
      const goal = targetRef.current;
      setShown((current) => {
        if (reducedMotion()) return goal;
        // A revised guess takes back what no longer matches.
        let common = 0;
        while (common < current.length && current[common] === goal[common]) common += 1;
        const base = current.slice(0, common);
        const backlog = goal.length - base.length;
        // Catches up faster the further behind it is, so it never lags far.
        const perSecond = Math.max(28, backlog * 10);
        budget += ((now - last) / 1000) * perSecond;
        const take = Math.floor(budget);
        budget -= take;
        return goal.slice(0, base.length + Math.min(take, backlog));
      });
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <>
      {shown}
      <span aria-hidden className="voice-text-caret" />
    </>
  );
}

// --- D: a light sweeps across the words still being worked out ---

function ShimmerPending({ heard }: { heard: Heard }) {
  return (
    <>
      {heard.settled}
      {heard.pending ? <span className="voice-text-shimmer">{heard.pending}</span> : null}
    </>
  );
}

const STYLES = `
@keyframes voice-text-fade-in {
  from { opacity: 0; filter: blur(4px); }
  to { opacity: 1; filter: blur(0); }
}
.voice-text-fade { animation: voice-text-fade-in 380ms ease-out both; }
@keyframes voice-text-blink { 50% { opacity: 0; } }
.voice-text-caret {
  display: inline-block; width: 2px; height: 1.1em; margin-left: 1px;
  vertical-align: text-bottom; background: var(--color-primary);
  animation: voice-text-blink 1s steps(1) infinite;
}
@keyframes voice-text-sweep { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.voice-text-shimmer {
  background: linear-gradient(90deg,
    var(--color-subtle-foreground) 0%, var(--color-subtle-foreground) 35%,
    var(--color-foreground) 50%,
    var(--color-subtle-foreground) 65%, var(--color-subtle-foreground) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: voice-text-sweep 1.4s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .voice-text-fade { animation: none; }
  .voice-text-caret { animation: none; }
  .voice-text-shimmer { animation: none; color: var(--color-subtle-foreground); background: none; }
}
`;

const VARIANTS: {
  letter: string;
  name: string;
  description: string;
  Render: (props: { heard: Heard; language: Language }) => React.ReactNode;
}[] = [
  {
    letter: "Today",
    name: "No animation",
    description: "What ships now: the text in the field replaces itself at each update.",
    Render: Plain,
  },
  {
    letter: "A",
    name: "Fade in",
    description:
      "Each new word fades and sharpens in. A word the transcriber corrects fades in again.",
    Render: FadeIn,
  },
  {
    letter: "B",
    name: "Dim until settled",
    description:
      "Words the transcriber may still change show dimmed and darken once they are final, so a correction reads as expected.",
    Render: DimPending,
  },
  {
    letter: "C",
    name: "Typewriter",
    description:
      "The text types itself out at an even pace behind a cursor, smoothing the bursts the transcriber sends.",
    Render: Typewriter,
  },
  {
    letter: "D",
    name: "Shimmer while working",
    description:
      "A light sweeps across the words that may still change, the way a loading label does, and stops once they are final.",
    Render: ShimmerPending,
  },
];

export function VoiceTextStreaming() {
  const [language, setLanguage] = useState<Language>("en");
  const transcriber = useSimulatedTranscriber(language);
  const { play } = transcriber;
  // Starts once on open and again whenever the language changes.
  useEffect(() => {
    play();
  }, [play]);

  return (
    <section className="flex flex-col gap-6">
      <style>{STYLES}</style>
      <header className="flex flex-col gap-3">
        <h2 className="text-title font-semibold">Transcribed text arriving</h2>
        <p className="text-ui text-muted-foreground">
          A simulated transcriber sends the same words to every field at speaking pace, including
          the corrections a real one makes. Only the text animation differs.
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
      {VARIANTS.map(({ letter, name, description, Render }) => (
        <div key={letter} className="flex flex-col gap-3">
          <div>
            <h3 className="text-ui font-medium text-foreground">
              {letter}. {name}
            </h3>
            <p className="text-aux text-muted-foreground">{description}</p>
          </div>
          <div className="min-h-24 rounded-16 border border-border bg-muted px-4 py-3 text-composer text-foreground">
            <Render heard={transcriber.heard} language={language} />
          </div>
        </div>
      ))}
    </section>
  );
}
