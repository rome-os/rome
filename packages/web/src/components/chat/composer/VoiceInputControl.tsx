import { Mic, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
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
