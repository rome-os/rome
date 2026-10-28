import "./styles.css";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Circle, CircleDot, Minus } from "lucide-react";
import { fetchAppApi, navigateRome, startChat, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { cn } from "@/lib/utils";
import { fireBurst, fireWelcome } from "@/lib/confetti";
import { getWelcomeCopy } from "@/lib/copy";
import { type Landing, type LandingData, loadLanding, STEPS, startWelcomeRun } from "@/lib/landing";

// Side-effect imports: each module's top-level `defineComponent(...)` registers
// an inline chat component into the SDK registry at bundle load, so the host can
// mount them when the welcome-to-rome turn-middleware renders them in the
// transcript during the conversation this screen kicks off.
import "@/name-card";
import "@/idea-picker";
import "@/scout-suggestions";

// The animated Rome brand mark. Resolved relative to this module so it works
// from the app's asset base at runtime; Rslib emits it to
// `dist/web/static/media/rome-logo-2.mp4`, and it's tracked via Git LFS
// (.gitattributes `*.mp4`).
const ROME_LOGO_VIDEO = new URL("./assets/rome-logo-2.mp4", import.meta.url).href;
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

type Copy = ReturnType<typeof getWelcomeCopy>;

function greetingFor(landing: Landing, agentName: string, copy: Copy): string {
  switch (landing.kind) {
    case "fresh":
      return copy.landing.greeting(agentName);
    case "resume":
      return landing.chatId
        ? copy.landing.resumeGreeting(copy.landing.steps[STEPS[landing.stepIndex]])
        : copy.landing.resumeGreetingNoChat;
    case "done":
      return copy.landing.doneGreeting;
    case "error":
      return copy.landing.loadError;
  }
}

/** The four setup steps, each marked done, current, still to come, or skipped. */
function StepList({
  stepIndex,
  aiConnected,
  copy,
}: {
  stepIndex: number;
  aiConnected: boolean | null;
  copy: Copy;
}) {
  return (
    <ol className="flex w-full max-w-xs flex-col gap-2 text-left text-ui">
      {STEPS.map((step, i) => {
        const past = i < stepIndex;
        const current = i === stepIndex;
        const skipped = past && step === "ai" && aiConnected === false;
        const Icon = skipped ? Minus : past ? Check : current ? CircleDot : Circle;
        return (
          <li
            key={step}
            aria-current={current ? "step" : undefined}
            className={cn(
              "flex items-center gap-2",
              current ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            <Icon
              aria-hidden
              className={cn("size-4 shrink-0", past && !skipped && "text-primary")}
            />
            <span className="flex-1">{copy.landing.steps[step]}</span>
            {skipped ? (
              <span className="text-aux">{copy.landing.stepSkipped}</span>
            ) : past ? (
              <span className="sr-only">{copy.landing.stepDone}</span>
            ) : current ? (
              <span className="sr-only">{copy.landing.stepCurrent}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export default function App({ bootstrap }: { bootstrap: RomeAppBootstrap }) {
  const copy = getWelcomeCopy(bootstrap.shell.locale);
  const [screen, setScreen] = useState<LandingData | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { shown, done } = useTypewriter(
    screen ? greetingFor(screen.landing, screen.agentName, copy) : "",
  );

  // Bumped by Try again to read the run's state once more.
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void loadLanding(
      () => fetchAppApi("state"),
      (path, init) => fetch(path, init),
      (sessionId) =>
        fetchAppApi("session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        }),
    ).then((data) => {
      if (!cancelled) setScreen(data);
    });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  function retryLoad() {
    setScreen(null);
    setLoadAttempt((n) => n + 1);
  }

  // Fire the welcome burst on a first run — the guardian's first moment in
  // Rome. A guardian coming back to a run already had it. Honours
  // prefers-reduced-motion internally.
  const landingKind = screen?.landing.kind;
  useEffect(() => {
    if (landingKind !== "fresh") return;
    const t = setTimeout(() => void fireWelcome(), 450);
    return () => clearTimeout(t);
  }, [landingKind]);

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

  // Start a new welcome run in a new chat. The kickoff message becomes the
  // guardian's first chat turn. The turn-middleware state machine ignores its
  // text and greets (script.ts `greet` node), but it still shows in the
  // transcript — so it reads like something the guardian said.
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

    const runUnderWay = screen?.landing.kind !== "fresh";
    const outcome = await startWelcomeRun({
      runUnderWay,
      // Reset the welcome progress so the new chat replays from a clean slate.
      // This full-mode page is outside RomeShellLayout, so include its
      // bootstrap locale for the server-side middleware before opening the
      // chat.
      reset: () =>
        fetchAppApi("reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ locale: bootstrap.shell.locale }),
        }),
      // startChat creates the session with the welcome-to-rome agent, posts the
      // kickoff turn, and soft-navigates to /chat/<id> — where the conversational
      // onboarding takes over.
      openChat: () => startChat({ message: copy.landing.kickoff, agentName: "welcome-to-rome" }),
    });
    if (outcome === "started") return;
    setError(copy.landing.openError);
    setStarting(false);
    // The reset went through but no chat opened, so the run on screen is gone.
    if (outcome === "start_failed" && runUnderWay) retryLoad();
  }

  function openChat(sessionId: string) {
    navigateRome({ path: "chat", sessionId });
  }

  const landing: Landing | null = screen?.landing ?? null;
  const chatId = landing && "chatId" in landing ? landing.chatId : null;
  const startLabel = starting ? copy.landing.opening : copy.landing.start;
  const restartLabel = starting ? copy.landing.opening : copy.landing.restart;

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

      {/* Where the run stands and what to do next only appear once the agent
          has finished speaking — fading and rising in rather than popping. */}
      <div
        className={cn(
          "mt-7 flex flex-col items-center gap-6 transition-all duration-500 ease-out",
          done ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
      >
        {landing?.kind === "resume" ? (
          <StepList stepIndex={landing.stepIndex} aiConnected={landing.aiConnected} copy={copy} />
        ) : landing?.kind === "done" ? (
          <StepList stepIndex={STEPS.length} aiConnected={landing.aiConnected} copy={copy} />
        ) : null}

        <div className="flex flex-col items-center gap-3">
          {!landing ? null : landing.kind === "error" ? (
            <Button size="md" onClick={retryLoad} disabled={!done}>
              {copy.landing.retry}
            </Button>
          ) : landing.kind === "fresh" || (landing.kind === "resume" && !chatId) ? (
            <Button
              ref={buttonRef}
              size="md"
              onClick={handleStart}
              disabled={starting || !done}
              className={cn("group", starting && "opacity-80")}
            >
              {landing.kind === "fresh" ? startLabel : restartLabel}
              <ArrowRight
                data-icon="inline-end"
                className="transition-transform group-hover:translate-x-0.5"
              />
            </Button>
          ) : landing.kind === "resume" && chatId ? (
            <Button
              size="md"
              onClick={() => openChat(chatId)}
              disabled={starting || !done}
              className="group"
            >
              {copy.landing.resume}
              <ArrowRight
                data-icon="inline-end"
                className="transition-transform group-hover:translate-x-0.5"
              />
            </Button>
          ) : (
            <Button
              size="md"
              onClick={() => navigateRome({ path: "chat/new" })}
              disabled={starting || !done}
              className="group"
            >
              {copy.landing.newChat}
              <ArrowRight
                data-icon="inline-end"
                className="transition-transform group-hover:translate-x-0.5"
              />
            </Button>
          )}

          {landing?.kind === "done" && chatId ? (
            <Button
              variant="outline"
              size="md"
              onClick={() => openChat(chatId)}
              disabled={starting || !done}
            >
              {copy.landing.openWelcomeChat}
            </Button>
          ) : null}

          {(landing?.kind === "resume" && chatId) || landing?.kind === "done" ? (
            <Button
              ref={buttonRef}
              variant="ghost"
              size="sm"
              onClick={handleStart}
              disabled={starting || !done}
            >
              {restartLabel}
            </Button>
          ) : null}

          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}
