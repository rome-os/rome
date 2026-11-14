import { useTranslation } from "react-i18next";
import { FormRow, FormRowDescription, FormRowHeading, FormRowLabel } from "@rome-os/ui/layout-form";
import type { VoiceInputInfo } from "@rome/api-types/voice-input";
import { useVoiceInputInfo } from "@/hooks/use-voice-input-info";

/** Names where the dashboard's dictated speech becomes text. */
export function VoiceInputRow() {
  const { t } = useTranslation("settings");
  // Rome Cloud can move voice input to another provider, so read the place
  // again each time Settings opens.
  const query = useVoiceInputInfo({ refetchOnMount: "always" });
  const info = query.data;
  return (
    <FormRow>
      <FormRowHeading>
        <FormRowLabel>{t("system.voiceInput.title")}</FormRowLabel>
        <FormRowDescription role={query.isError ? "alert" : undefined}>
          {query.isPending
            ? t("system.voiceInput.loading")
            : query.isError
              ? t("system.voiceInput.loadFailed")
              : describe(info, t)}
        </FormRowDescription>
      </FormRowHeading>
    </FormRow>
  );
}

function describe(
  info: VoiceInputInfo | undefined,
  t: (key: string, options?: Record<string, string>) => string,
): string {
  if (!info?.available) return t("system.voiceInput.off");
  const place = info.place;
  if (info.via === "rome-cloud") {
    return place
      ? t("system.voiceInput.placeViaRomeCloud", { provider: place.provider, host: place.host })
      : info.placeUnknown === "rome-cloud-not-configured"
        ? t("system.voiceInput.romeCloudNotConfigured")
        : t("system.voiceInput.romeCloudUnreachable");
  }
  return place
    ? t("system.voiceInput.place", { provider: place.provider, host: place.host })
    : t("system.voiceInput.off");
}
