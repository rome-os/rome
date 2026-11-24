import type { VoiceConversationState } from "@rome/api-types/voice-conversation";
import { AudioLines, MicOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Starts a voice conversation in this chat. Sits beside the voice input microphone. */
export function VoiceConversationButton({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation("chat");
  const label = t("voiceConversation.start");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onStart}
      className="touch-target"
    >
      <AudioLines aria-hidden />
    </Button>
  );
}

/** Mutes the microphone during a voice conversation. Pressed while muted. */
export function VoiceConversationMute({
  muted,
  onToggle,
}: {
  muted: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("chat");
  const label = muted ? t("voiceConversation.unmute") : t("voiceConversation.mute");
  return (
    <Button
      type="button"
      variant={muted ? "default" : "ghost"}
      size="icon-sm"
      aria-pressed={muted}
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className="touch-target"
    >
      <MicOff aria-hidden />
    </Button>
  );
}

/** Ends the voice conversation. */
export function VoiceConversationEnd({ onEnd }: { onEnd: () => void }) {
  const { t } = useTranslation("chat");
  return (
    <Button
      type="button"
      size="sm"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onEnd}
      className="touch-target rounded-full px-4"
    >
      {t("voiceConversation.end")}
    </Button>
  );
}

// Each bar's share of the loudness, so the row reads as a voice rather than a meter.
const SHAPE = [0.5, 0.75, 1, 0.82, 0.95, 0.7, 0.55, 0.85, 0.62, 0.72, 0.48, 0.58, 0.36, 0.3];
const BAR_PX = 4;
const DOT_PX = 4;

/**
 * The capsule above the composer during a voice conversation: a thin outline
 * around the Rome logo and a row of bars. Listening, the bars follow the
 * guardian's microphone in the text colour; speaking, they follow Rome's voice
 * in the accent colour; thinking, a slow wave runs over low dots; muted, the
 * whole capsule turns grey and the bars rest. With reduced motion the bars
 * stay still and only colour changes. `level` is read once a frame.
 */
export function VoiceConversationCapsule({
  state,
  muted,
  level,
}: {
  state: VoiceConversationState;
  muted: boolean;
  level: () => number;
}) {
  const { t } = useTranslation("chat");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  const shown = muted ? "muted" : state;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame = 0;
    // The bars ease toward each new reading, so a syllable rises and falls.
    let eased = 0;
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
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      context.globalAlpha = shown === "thinking" ? 0.6 : 1;
      const t = now / 1000;
      const reading = shown === "listening" || shown === "speaking" ? levelRef.current() : 0;
      eased += (reading - eased) * 0.35;
      const gap = (width - SHAPE.length * BAR_PX) / (SHAPE.length - 1);
      SHAPE.forEach((share, i) => {
        let value = 0;
        if (reduce) value = shown === "muted" ? 0 : share * 0.5;
        else if (shown === "thinking")
          value = 0.12 + 0.3 * (0.5 + 0.5 * Math.sin(t * 2.4 - i * 0.5)) ** 2;
        else if (shown !== "muted")
          value = Math.sqrt(eased) * share * (0.7 + 0.3 * Math.sin(t * (8 + i * 0.7) + i * 1.9));
        const bar = DOT_PX + (height - DOT_PX) * Math.max(0, Math.min(1, value));
        context.beginPath();
        context.roundRect(i * (BAR_PX + gap), (height - bar) / 2, BAR_PX, bar, BAR_PX / 2);
        context.fill();
      });
      if (!reduce) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  return (
    <div
      data-voice-conversation-capsule
      data-state={shown}
      className={cn(
        "mx-auto mb-2 flex h-12 w-fit items-center gap-3 rounded-full border-[1.5px] bg-background px-4 transition-colors",
        shown === "muted" ? "border-subtle-foreground" : "border-foreground",
      )}
    >
      <RomeLogo
        aria-hidden
        className={cn(
          "h-auto w-5.5 transition-colors",
          shown === "muted" ? "text-subtle-foreground" : "text-foreground",
        )}
      />
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn(
          "h-7 w-27",
          shown === "speaking"
            ? "text-primary"
            : shown === "muted"
              ? "text-subtle-foreground"
              : "text-foreground",
        )}
      />
      <span role="status" className="sr-only">
        {t(`voiceConversation.state.${shown}`)}
      </span>
    </div>
  );
}
