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
  findMicrophone,
  listMicrophones,
  type MicrophoneOption,
  revealMicrophones,
} from "@/lib/voice-input/microphone-choice";

/**
 * Voice input's settings: which microphone it records from, and, while Rome
 * Cloud cannot serve it, why. Absent on an instance without voice input,
 * including an account Rome Cloud does not allow it for.
 */
export function VoiceInputRow() {
  const { t } = useTranslation("settings");
  // Whether Rome Cloud can serve voice input changes, so ask again each time
  // Settings opens.
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
  const problem = describeProblem(info, t);
  return (
    <>
      {problem && (
        <FormRow>
          <FormRowHeading>
            <FormRowLabel>{t("system.voiceInput.title")}</FormRowLabel>
            <FormRowDescription>{problem}</FormRowDescription>
          </FormRowHeading>
        </FormRow>
      )}
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

  // A failed listing keeps the last list. Before any list, the select stays
  // disabled and shows no choice.
  const refresh = useCallback(() => {
    listMicrophones().then(setOptions, () => {});
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

  // An unplugged microphone leaves the list, and the choice switches to the
  // system default, which voice input then records from. Only a list that
  // names some microphone counts: an empty one may be the browser not answering.
  const found = options ? findMicrophone(chosen, options) : null;
  const unplugged = chosen !== null && !!options?.length && found === null;
  // A choice found by name gets the device's new id, and one saved before
  // names were kept gets its name.
  const stale = found !== null && (found.id !== chosen?.id || found.label !== chosen.label);
  useEffect(() => {
    if (unplugged) setChosen(chooseMicrophone(null));
    else if (stale && found) setChosen(chooseMicrophone(found));
  }, [unplugged, stale, found]);
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
            value={options === undefined ? "" : (found?.id ?? SYSTEM_DEFAULT)}
            disabled={options === undefined}
            onValueChange={(value) =>
              setChosen(chooseMicrophone(options?.find((option) => option.id === value) ?? null))
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

/** Why Rome Cloud cannot serve voice input right now; null while it can. */
function describeProblem(
  info: VoiceInputInfo,
  t: (key: string, options?: Record<string, string>) => string,
): string | null {
  if (info.place) return null;
  return info.placeUnknown === "rome-cloud-not-configured"
    ? t("system.voiceInput.romeCloudNotConfigured")
    : info.placeUnknown === "rome-cloud-signed-out"
      ? t("system.voiceInput.romeCloudSignedOut")
      : t("system.voiceInput.romeCloudUnreachable");
}
