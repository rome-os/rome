import { Mic, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { DictationStopReason } from "@/lib/voice-input/dictation";
import type { VoiceInputState } from "./use-voice-input";

/**
 * The composer's voice control. Its name and `aria-pressed` are a contract
 * with the voice input verifier: "Start voice input" and false while idle,
 * "Stop voice input" and true while listening.
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
  const label = listening ? t("voiceInput.stop") : t("voiceInput.start");
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

/** Why listening stopped without the guardian's stop. Renders nothing when there is no reason. */
export function VoiceInputNotice({ reason }: { reason: DictationStopReason | null }) {
  const { t } = useTranslation("chat");
  if (!reason) return null;
  return (
    <div role="status" className="mb-2 text-aux text-muted-foreground">
      {t(`voiceInput.stopped.${reason}`)}
    </div>
  );
}
