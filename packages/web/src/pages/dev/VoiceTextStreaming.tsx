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

// --- A: each new word fades and sharpens in ---

function FadeIn({
  heard,
  language,
  fade = "voice-text-fade",
}: {
  heard: Heard;
  language: Language;
  fade?: string;
}) {
  const all = units(heard.settled + heard.pending, language);
  return (
    <>
      {all.map((unit, i) => (
        // The key changes when a guess is revised, so the corrected word fades in again.
        <span key={`${i}:${unit.trim()}`} className={fade}>
          {unit}
        </span>
      ))}
    </>
  );
}

const STYLES = `
@keyframes voice-text-fade-in {
  from { opacity: 0; filter: blur(4px); }
  to { opacity: 1; filter: blur(0); }
}
.voice-text-fade { animation: voice-text-fade-in 380ms ease-out both; }
@keyframes voice-text-soft-in { from { opacity: 0; } to { opacity: 1; } }
.voice-text-soft { animation: voice-text-soft-in 600ms cubic-bezier(0.25, 0.1, 0.25, 1) both; }
@keyframes voice-text-mist-in {
  from { opacity: 0.15; filter: blur(1.5px); }
  to { opacity: 1; filter: blur(0); }
}
.voice-text-mist { animation: voice-text-mist-in 800ms cubic-bezier(0.25, 0.1, 0.25, 1) both; }
@keyframes voice-text-ink-in {
  from { opacity: 0; color: var(--color-subtle-foreground); }
  60% { opacity: 1; }
  to { opacity: 1; color: var(--color-foreground); }
}
.voice-text-ink { animation: voice-text-ink-in 1100ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .voice-text-fade, .voice-text-soft, .voice-text-mist, .voice-text-ink { animation: none; }
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
    name: "Fade in, first take",
    description: "The one you picked: fades and sharpens from a 4 px blur over 0.4 s.",
    Render: FadeIn,
  },
  {
    letter: "A1",
    name: "Soft",
    description: "Opacity only, no blur, over 0.6 s with an even ease.",
    Render: (props) => <FadeIn {...props} fade="voice-text-soft" />,
  },
  {
    letter: "A2",
    name: "Mist",
    description:
      "Starts faintly visible with a slight 1.5 px blur and clears over 0.8 s, so no word ever pops from nothing.",
    Render: (props) => <FadeIn {...props} fade="voice-text-mist" />,
  },
  {
    letter: "A3",
    name: "Ink",
    description:
      "Fades in light grey, then darkens to the text colour over 1.1 s, like ink drying.",
    Render: (props) => <FadeIn {...props} fade="voice-text-ink" />,
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
        <h2 className="text-title font-semibold">Transcribed text arriving: gentler fade</h2>
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
