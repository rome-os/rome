import { Mic, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { DictationStop } from "@/lib/voice-input/dictation";
import type { VoiceInputState } from "./use-voice-input";

/**
 * The composer's voice control. Its name and `aria-pressed` are a contract
 * with the voice input verifier: "Start voice input" and false only while
 * idle, "Stop voice input" and true while listening, and "Finishing voice
 * input" while the rest of the text is on its way and the field is read-only.
 */
export function VoiceInputButton({
  state,
  onToggle,
}: {
  state: VoiceInputState;
  onToggle: () => void;
}) {
  const { t } = useTranslation("chat");
  const listening = state === "listening";
  const label = listening
    ? t("voiceInput.stop")
    : state === "finishing"
      ? t("voiceInput.finishing")
      : t("voiceInput.start");
  return (
    <Button
      type="button"
      variant={listening ? "default" : "ghost"}
      size="icon-sm"
      aria-pressed={listening}
      aria-label={label}
      title={label}
      disabled={state === "finishing"}
      // Keeps focus, and with it the cursor the spoken text lands at, in the field.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className="touch-target"
    >
      {listening ? <Square aria-hidden className="fill-current" /> : <Mic aria-hidden />}
    </Button>
  );
}

// One bar per 50 ms. Each bar is the loudest reading in its 50 ms, so a short
// syllable still shows.
const WAVE_STEP_MS = 50;
const WAVE_BAR_PX = 3;
const WAVE_GAP_PX = 2;
const WAVE_HISTORY_MS = 5000;
// Loudness below this is a quiet room, not speech.
const SILENCE = 0.02;

/**
 * The microphone's last 5 seconds of sound as bars scrolling in from the
 * right, so the guardian sees voice input hears them. Silence is a flat row
 * of dots, so once it has lasted 5 seconds the waveform looks still. `level`
 * is read once a frame. Decoration only: the voice control says whether it
 * listens.
 */
export function VoiceInputWaveform({
  level,
  className,
}: {
  level: () => number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    // Fewer, slower steps when the guardian asks for less motion.
    const step = reduce ? WAVE_STEP_MS * 4 : WAVE_STEP_MS;
    const bars: number[] = [];
    let peak = 0;
    let lastStep = performance.now();
    let frame = 0;
    const draw = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const ratio = window.devicePixelRatio || 1;
      if (
        canvas.width !== Math.round(width * ratio) ||
        canvas.height !== Math.round(height * ratio)
      ) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      // At most the last 5 seconds, however wide the field.
      const capacity = Math.min(
        Math.ceil(width / (WAVE_BAR_PX + WAVE_GAP_PX)),
        Math.floor(WAVE_HISTORY_MS / step),
      );
      // Opens as a flat row of dots, which the first sound pushes along.
      while (bars.length < capacity) bars.unshift(0);
      if (bars.length > capacity) bars.splice(0, bars.length - capacity);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      for (let i = 0; i < bars.length; i++) {
        const x = width - (i + 1) * (WAVE_BAR_PX + WAVE_GAP_PX);
        if (x < 0) break;
        const barHeight = Math.max(2, (bars[bars.length - 1 - i] ?? 0) * height);
        // Older bars fade toward the left edge.
        context.globalAlpha = Math.max(0.25, 1 - (i / capacity) * 0.75);
        context.beginPath();
        context.roundRect(x, (height - barHeight) / 2, WAVE_BAR_PX, barHeight, WAVE_BAR_PX / 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    const tick = (now: number) => {
      peak = Math.max(peak, levelRef.current());
      if (now - lastStep >= step) {
        lastStep = now;
        // Silence scrolls by as a flat row of dots, so a spike always means sound.
        bars.push(peak > SILENCE ? peak : 0);
        peak = 0;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    draw();
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-voice-input-waveform
      className={cn("h-7 min-w-0 text-primary", className)}
    />
  );
}

// Rome Cloud's reason codes the dashboard words itself. Any other code shows
// in the general refusal sentence.
const ROME_CLOUD_REASONS = new Set([
  "voice_input_rate_limited",
  "voice_input_not_configured",
  "provider_unavailable",
  "insufficient_credits",
]);

/** Why listening stopped without the guardian's stop. Renders nothing when there is no reason. */
export function VoiceInputNotice({
  notice,
  asking = false,
}: {
  notice: DictationStop | null;
  /** While the browser asks for the microphone, the notice says what Rome uses it for. */
  asking?: boolean;
}) {
  const { t } = useTranslation("chat");
  if (asking) {
    return (
      <div role="status" className="mb-2 text-aux text-muted-foreground">
        {t("voiceInput.whyMicrophone")}
      </div>
    );
  }
  if (!notice) return null;
  const { reason, detail } = notice;
  const text =
    reason === "service-refused" && detail && ROME_CLOUD_REASONS.has(detail)
      ? t(`voiceInput.romeCloud.${detail}`)
      : t(`voiceInput.stopped.${reason}`, { code: detail ?? "" });
  return (
    <div role="status" className="mb-2 text-aux text-muted-foreground">
      {text}
    </div>
  );
}
