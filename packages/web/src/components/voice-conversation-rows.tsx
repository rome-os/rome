import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Play, Square } from "lucide-react";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import {
  VOICE_CONVERSATION_SPEEDS,
  VOICE_CONVERSATION_VOICES,
  type VoiceConversationSettings,
  type VoiceConversationVoice,
  voiceConversationSettingsSchema,
} from "@rome/api-types/voice-conversation";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useVoiceConversationInfo } from "@/hooks/use-voice-conversation-info";
import { fetchJson } from "@/lib/fetch-json";

const SETTINGS_URL = "/api/voice-conversation/settings";
const settingsKey = ["voice-conversation", "settings"];

/**
 * How Rome speaks in a voice conversation: its voice, which plays a sample as
 * it is picked, and how fast. Every conversation reads them as it starts, on
 * the web and on iPhone. Absent where no voice conversation is offered.
 */
export function VoiceConversationRows() {
  const { t, i18n } = useTranslation("settings");
  const uid = useId();
  const client = useQueryClient();
  const info = useVoiceConversationInfo();
  const fallback = t("system.voiceConversation.loadFailed");
  const query = useQuery({
    queryKey: settingsKey,
    enabled: Boolean(info.data?.available),
    queryFn: async ({ signal }) =>
      voiceConversationSettingsSchema.parse(
        await fetchJson<unknown>(SETTINGS_URL, { signal, fallback }),
      ),
  });
  const mutation = useMutation({
    mutationFn: async (next: VoiceConversationSettings) =>
      voiceConversationSettingsSchema.parse(
        await fetchJson<unknown>(SETTINGS_URL, { method: "PUT", json: next, fallback }),
      ),
    onSuccess: (settings) => client.setQueryData(settingsKey, settings),
  });
  const sample = useSample(i18n.language.startsWith("zh") ? "zh" : "en");
  if (!info.data?.available) return null;

  const settings = mutation.isPending ? mutation.variables : query.data;
  const update = (patch: Partial<VoiceConversationSettings>, hear: boolean) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    mutation.mutate(next);
    if (hear) sample.play(next);
  };
  const failed = query.isError || mutation.isError;
  const status = failed
    ? fallback
    : sample.failed
      ? t("system.voiceConversation.sampleFailed")
      : t("system.voiceConversation.voice.description");

  return (
    <>
      <FormRow>
        <FormRowHeading>
          <FormRowLabel htmlFor={`${uid}-voice`}>
            {t("system.voiceConversation.voice.title")}
          </FormRowLabel>
          <FormRowDescription aria-live="polite" role={failed ? "alert" : undefined}>
            {status}
          </FormRowDescription>
        </FormRowHeading>
        <FormRowControl>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!settings}
            aria-label={
              sample.playing
                ? t("system.voiceConversation.stopSample")
                : t("system.voiceConversation.playSample")
            }
            onClick={() => (sample.playing ? sample.stop() : settings && sample.play(settings))}
          >
            {sample.playing ? <Square aria-hidden /> : <Play aria-hidden />}
          </Button>
          <Select
            value={settings?.voice ?? ""}
            disabled={!settings}
            onValueChange={(voice) => update({ voice: voice as VoiceConversationVoice }, true)}
          >
            <SelectTrigger
              id={`${uid}-voice`}
              aria-label={t("system.voiceConversation.voice.title")}
            >
              {/* The name only: the list says what each voice sounds like. */}
              <SelectValue>{settings?.voice}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {VOICE_CONVERSATION_VOICES.map((voice) => (
                <SelectItem key={voice.id} value={voice.id}>
                  <span className="flex flex-col">
                    <span>{voice.id}</span>
                    <span className="text-aux text-muted-foreground">
                      {t(`system.voiceConversation.voices.${voice.id}`)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRowControl>
      </FormRow>
      <FormRow>
        <FormRowHeading>
          <FormRowLabel htmlFor={`${uid}-speed`}>
            {t("system.voiceConversation.speed.title")}
          </FormRowLabel>
          <FormRowDescription>{t("system.voiceConversation.speed.description")}</FormRowDescription>
        </FormRowHeading>
        <FormRowControl>
          <Select
            value={settings ? String(settings.speed) : ""}
            disabled={!settings}
            onValueChange={(speed) => update({ speed: Number(speed) }, true)}
          >
            <SelectTrigger
              id={`${uid}-speed`}
              aria-label={t("system.voiceConversation.speed.title")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {VOICE_CONVERSATION_SPEEDS.map((speed) => (
                <SelectItem key={speed} value={String(speed)}>
                  {`${speed}×`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRowControl>
      </FormRow>
    </>
  );
}

/** Plays a sample of a voice at a speed. A new sample stops the one playing. */
function useSample(language: "zh" | "en") {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = useRef<{ audio: HTMLAudioElement | null; abort: AbortController } | null>(null);

  const stop = () => {
    const was = current.current;
    current.current = null;
    was?.abort.abort();
    if (was?.audio) {
      was.audio.pause();
      URL.revokeObjectURL(was.audio.src);
    }
    setPlaying(false);
  };

  const play = (settings: VoiceConversationSettings) => {
    stop();
    const mine = { audio: null as HTMLAudioElement | null, abort: new AbortController() };
    current.current = mine;
    setPlaying(true);
    setFailed(false);
    // Made now, from the click, so the browser lets it play once the sample is in.
    const audio = new Audio();
    void fetch("/api/voice-conversation/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...settings, language }),
      signal: mine.abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (current.current !== mine) return;
        audio.src = URL.createObjectURL(blob);
        mine.audio = audio;
        audio.onended = () => {
          if (current.current === mine) stop();
        };
        await audio.play();
      })
      .catch(() => {
        if (current.current !== mine) return;
        current.current = null;
        setPlaying(false);
        setFailed(true);
      });
  };

  // Leaving Settings stops the sample.
  useEffect(() => () => current.current?.audio?.pause(), []);

  return { play, stop, playing, failed };
}
