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
      variant={listening ? "secondary" : "ghost"}
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

// One step per 50 ms. Each step is the loudest reading in its 50 ms, so a
// short syllable still shows.
const WAVE_STEP_MS = 50;
const WAVE_BAR_PX = 3;
const WAVE_GAP_PX = 3;
// A quiet step is a dot this wide.
const WAVE_DOT_PX = 2;
// Loudness below this is a quiet room, not speech.
const SILENCE = 0.02;
// Quiet steps are dimmer than sound.
const DOT_ALPHA = 0.4;

/**
 * The microphone's recent sound, scrolling in from the right across the
 * whole of the message field's bottom row, so the guardian sees voice input
 * hears them. Sound is a bar in the text color; silence is a flat row of
 * dimmer dots, so a bar that rises always means sound. The row slides
 * smoothly between steps, and the oldest steps fade out at the left edge.
 * `level` is read once a frame. Decoration only: the voice control says
 * whether it listens.
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
    // Fewer, slower steps that jump rather than slide when the guardian asks
    // for less motion.
    const step = reduce ? WAVE_STEP_MS * 4 : WAVE_STEP_MS;
    const pitch = WAVE_BAR_PX + WAVE_GAP_PX;
    const steps: number[] = [];
    let peak = 0;
    let lastStep = performance.now();
    let frame = 0;
    const draw = (now: number) => {
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
      // As many steps as fill the width, and one more that slides out past
      // the left edge.
      const capacity = Math.ceil(width / pitch) + 1;
      // Opens as a flat row of dots, which the first sound pushes along.
      while (steps.length < capacity) steps.unshift(0);
      if (steps.length > capacity) steps.splice(0, steps.length - capacity);
      // How much of a step the newest still has to travel in from the right.
      const slide = reduce ? 0 : Math.max(0, 1 - (now - lastStep) / step);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      for (let i = 0; i < steps.length; i++) {
        const x = width - (i + 1) * pitch + WAVE_GAP_PX + slide * pitch;
        if (x + WAVE_BAR_PX < 0) break;
        const value = steps[steps.length - 1 - i] ?? 0;
        context.beginPath();
        if (value > 0) {
          const barHeight = Math.max(WAVE_BAR_PX, value * height);
          context.globalAlpha = 1;
          context.roundRect(x, (height - barHeight) / 2, WAVE_BAR_PX, barHeight, WAVE_BAR_PX / 2);
        } else {
          context.globalAlpha = DOT_ALPHA;
          context.arc(x + WAVE_BAR_PX / 2, height / 2, WAVE_DOT_PX / 2, 0, Math.PI * 2);
        }
        context.fill();
      }
      context.globalAlpha = 1;
    };
    const tick = (now: number) => {
      peak = Math.max(peak, levelRef.current());
      const stepped = now - lastStep >= step;
      if (stepped) {
        // On the step's own schedule, not the frame's, so no step lasts a frame
        // longer and the slide never stalls. After a pause, such as a hidden
        // tab, it starts again from now.
        lastStep = now - lastStep < step * 2 ? lastStep + step : now;
        steps.push(peak > SILENCE ? peak : 0);
        peak = 0;
      }
      // Every frame while sliding; with less motion, only when a step lands.
      if (stepped || !reduce) draw(now);
      frame = requestAnimationFrame(tick);
    };
    draw(lastStep);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-voice-input-waveform
      className={cn(
        "h-7 min-w-0 text-foreground [mask-image:linear-gradient(to_right,transparent,black_12%)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_12%)]",
        className,
      )}
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
