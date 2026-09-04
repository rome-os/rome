import "./styles.css";
import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { fetchAppApi, startChat, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { cn } from "@/lib/utils";
import { fireBurst, fireWelcome } from "@/lib/confetti";
import { getWelcomeCopy } from "@/lib/copy";

// Side-effect imports: each module's top-level `defineComponent(...)` registers
// an inline chat component into the SDK registry at bundle load, so the host can
// mount them when the welcome-to-rome turn-middleware renders them in the
// transcript during the conversation this screen kicks off.
import "@/email-handshake";
import "@/email-receipt";
import "@/intro-choice";
import "@/browser-step";
import "@/idea-picker";
import "@/scout-suggestions";
import "@/completion-card";

// The animated Rome brand mark. Resolved relative to this module so it works
// from the app's asset base at runtime; Rslib emits it to
// `dist/web/static/media/rome-logo-2.mp4`, and it's tracked via Git LFS
// (.gitattributes `*.mp4`).
const ROME_LOGO_VIDEO = new URL("./assets/rome-logo-2.mp4", import.meta.url).href;
const FALLBACK_AGENT_NAME = "Rome";

// The agent's opening line — written to read like a person saying hello, not a
// product tagline. The active locale supplies it via `copy.landing.greeting`;
// it is typed out word by word below.
// Typewriter pacing — deliberately gentle (a greeting, not a loading bar); a
// longer beat trails sentence-ending punctuation for a natural cadence. Mirrors
// the in-chat typeOut feel (hooks/turn-middleware/index.ts).
const TYPE_START_MS = 650;
const TYPE_WORD_MS = 46;
const TYPE_SENTENCE_PAUSE_MS = 260;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

/** Reveal `text` token by token. Under reduced motion it appears at once. */
function useTypewriter(text: string): { shown: string; done: boolean } {
  const [shown, setShown] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    setShown("");
    setDone(false);
    if (!text) return;
    if (prefersReducedMotion()) {
      setShown(text);
      setDone(true);
      return;
    }
    // "word + its trailing whitespace" tokens; concatenated they reproduce text.
    const tokens = text.match(/\S+\s*/g) ?? [text];
    let i = 0;
    let acc = "";
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (i >= tokens.length) {
        setDone(true);
        return;
      }
      const token = tokens[i];
      acc += token;
      i += 1;
      setShown(acc);
      const pause = /[.!?:…\n]\s*$/.test(token) ? TYPE_SENTENCE_PAUSE_MS : TYPE_WORD_MS;
      timer = setTimeout(tick, pause);
    };
    timer = setTimeout(tick, TYPE_START_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return { shown, done };
}

function readAgentName(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : FALLBACK_AGENT_NAME;
}

export default function App({ bootstrap }: { bootstrap: RomeAppBootstrap }) {
  const copy = getWelcomeCopy(bootstrap.shell.locale);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { shown, done } = useTypewriter(agentName ? copy.landing.greeting(agentName) : "");

  useEffect(() => {
    let cancelled = false;
    void fetchAppApi("")
      .then(async (res) => {
        if (!res.ok) return FALLBACK_AGENT_NAME;
        const data = (await res.json().catch(() => ({}))) as { agentName?: unknown };
        return readAgentName(data.agentName);
      })
      .catch(() => FALLBACK_AGENT_NAME)
      .then((name) => {
        if (!cancelled) setAgentName(name);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fire the welcome burst once the screen mounts — the guardian's first moment
  // in Rome. Honours prefers-reduced-motion internally.
  useEffect(() => {
    const t = setTimeout(() => void fireWelcome(), 450);
    return () => clearTimeout(t);
  }, []);

  // Under reduced-motion, hold the brand mark on its first frame instead of
  // looping it.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (prefersReducedMotion()) {
      v.pause();
      v.currentTime = 0;
    }
  }, []);

  // The kickoff message becomes the guardian's first chat turn. The
  // turn-middleware state machine ignores its text and greets (script.ts
  // `greet` node), but it still shows in the transcript — so it reads like
  // something the guardian said.
  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);

    // A focused burst from the button before we hand off to the chat. The
    // confetti canvas lives on document.body, so it lingers as the soft
    // navigation swaps this screen for the chat.
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      void fireBurst({
        x: (rect.left + rect.width / 2) / window.innerWidth,
        y: (rect.top + rect.height / 2) / window.innerHeight,
      });
    }

    try {
      // Reset the welcome progress so every entry from this screen — a true
      // first run or a "run the welcome again" restart that landed back here —
      // replays from a clean slate. This full-mode page is outside
      // RomeShellLayout, so include its bootstrap locale for the server-side
      // middleware before opening the chat. A reset failure shouldn't block the
      // chat, so this remains best-effort.
      await fetchAppApi("reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: bootstrap.shell.locale }),
      }).catch(() => {});
      // startChat creates the session with the welcome-to-rome agent, posts the
      // kickoff turn, and soft-navigates to /chat/<id> — where the conversational
      // onboarding takes over.
      await startChat({ message: copy.landing.kickoff, agentName: "welcome-to-rome" });
    } catch {
      setError(copy.landing.openError);
      setStarting(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden p-8 text-center">
      {/* Rome's avatar: the animated brand video, floating over a soft glow. */}
      <div className="relative mb-6">
        <div
          aria-hidden
          className="wtr-glow absolute inset-0 -z-10 rounded-16 bg-primary/30 blur-2xl"
        />
        <div className="wtr-float">
          <video
            ref={videoRef}
            src={ROME_LOGO_VIDEO}
            className="wtr-pop size-24 rounded-16 bg-card object-cover shadow-10"
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            aria-hidden
          />
        </div>
      </div>

      {/* The agent speaking — typed out like a real hello. The min-height reserves the
          two-line block so the button below doesn't jump as text streams in. */}
      <p className="min-h-[5.5rem] max-w-md text-pretty text-lg font-medium leading-relaxed text-foreground sm:text-xl">
        {shown}
        {!done ? (
          <span
            aria-hidden
            className="wtr-caret ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.15em] bg-primary"
          />
        ) : null}
      </p>

      {/* The invitation only appears once the agent has finished saying hello —
          fading and rising in rather than popping. */}
      <div
        className={cn(
          "mt-7 flex flex-col items-center gap-3 transition-all duration-500 ease-out",
          done ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
      >
        <Button
          ref={buttonRef}
          size="md"
          onClick={handleStart}
          disabled={starting || !done}
          className={cn("group", starting && "opacity-80")}
        >
          {starting ? copy.landing.opening : copy.landing.start}
          <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
        </Button>
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}
