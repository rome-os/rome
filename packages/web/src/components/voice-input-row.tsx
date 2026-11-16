import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import type { VoiceInputInfo } from "@rome/api-types/voice-input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useVoiceInputInfo } from "@/hooks/use-voice-input-info";
import {
  chooseMicrophone,
  chosenMicrophone,
  listMicrophones,
  type MicrophoneOption,
  revealMicrophones,
} from "@/lib/voice-input/microphone-choice";

/**
 * Names where the dashboard's dictated speech becomes text. Absent on an
 * instance without voice input, including an account Rome Cloud does not
 * allow it for.
 */
export function VoiceInputRow() {
  const { t } = useTranslation("settings");
  // Rome Cloud can move voice input to another provider, so read the place
  // again each time Settings opens.
  const query = useVoiceInputInfo({ refetchOnMount: "always" });
  const info = query.data;
  if (query.isError) {
    return (
      <FormRow>
        <FormRowHeading>
          <FormRowLabel>{t("system.voiceInput.title")}</FormRowLabel>
          <FormRowDescription role="alert">{t("system.voiceInput.loadFailed")}</FormRowDescription>
        </FormRowHeading>
      </FormRow>
    );
  }
  if (!info?.available) return null;
  return (
    <>
      <FormRow>
        <FormRowHeading>
          <FormRowLabel>{t("system.voiceInput.title")}</FormRowLabel>
          <FormRowDescription>{describe(info, t)}</FormRowDescription>
        </FormRowHeading>
      </FormRow>
      <MicrophoneRow />
    </>
  );
}

/** The value the select uses for the system default, which has no device id. */
const SYSTEM_DEFAULT = "system-default";

/**
 * Which microphone voice input records from, kept in this browser. The
 * browser names its microphones only once the microphone has been allowed,
 * so until then the row offers to ask.
 */
function MicrophoneRow() {
  const { t } = useTranslation("settings");
  const uid = useId();
  // Undefined while loading; null while the browser hides the names.
  const [options, setOptions] = useState<MicrophoneOption[] | null | undefined>(undefined);
  const [chosen, setChosen] = useState(chosenMicrophone);
  const [refused, setRefused] = useState(false);

  const refresh = useCallback(() => {
    listMicrophones().then(setOptions, () => setOptions([]));
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setOptions([]);
      return;
    }
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [refresh]);

  const reveal = () => {
    revealMicrophones().then(
      () => {
        setRefused(false);
        refresh();
      },
      () => setRefused(true),
    );
  };

  // An unplugged microphone leaves the list, and Settings switches to the
  // system default, which voice input then records from.
  const missing = chosen !== null && options != null && !options.some((o) => o.id === chosen);
  useEffect(() => {
    if (missing) setChosen(chooseMicrophone(null));
  }, [missing]);
  const description = refused
    ? t("system.voiceInput.microphone.refused")
    : t("system.voiceInput.microphone.description");

  return (
    <FormRow>
      <FormRowHeading>
        {/* The button names itself; only the select takes the row's label. */}
        <FormRowLabel htmlFor={options === null ? undefined : `${uid}-microphone`}>
          {t("system.voiceInput.microphone.title")}
        </FormRowLabel>
        <FormRowDescription aria-live="polite">{description}</FormRowDescription>
      </FormRowHeading>
      <FormRowControl>
        {options === null ? (
          <Button variant="outline" size="sm" onClick={reveal}>
            {t("system.voiceInput.microphone.show")}
          </Button>
        ) : (
          <Select
            value={chosen && !missing ? chosen : SYSTEM_DEFAULT}
            disabled={options === undefined}
            onValueChange={(value) =>
              setChosen(chooseMicrophone(value === SYSTEM_DEFAULT ? null : value))
            }
          >
            <SelectTrigger
              id={`${uid}-microphone`}
              aria-label={t("system.voiceInput.microphone.title")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value={SYSTEM_DEFAULT}>
                {t("system.voiceInput.microphone.systemDefault")}
              </SelectItem>
              {options?.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormRowControl>
    </FormRow>
  );
}

function describe(
  info: VoiceInputInfo,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  const place = info.place;
  if (place)
    return t("system.voiceInput.placeViaRomeCloud", { provider: place.provider, host: place.host });
  return info.placeUnknown === "rome-cloud-not-configured"
    ? t("system.voiceInput.romeCloudNotConfigured")
    : info.placeUnknown === "rome-cloud-signed-out"
      ? t("system.voiceInput.romeCloudSignedOut")
      : t("system.voiceInput.romeCloudUnreachable");
}
