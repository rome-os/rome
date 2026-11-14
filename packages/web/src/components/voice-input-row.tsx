import { useTranslation } from "react-i18next";
import { FormRow, FormRowDescription, FormRowHeading, FormRowLabel } from "@rome-os/ui/layout-form";
import { useVoiceInputInfo } from "@/hooks/use-voice-input-info";

/** Names where the dashboard's dictated speech becomes text. */
export function VoiceInputRow() {
  const { t } = useTranslation("settings");
  const query = useVoiceInputInfo();
  const place = query.data?.place;
  return (
    <FormRow>
      <FormRowHeading>
        <FormRowLabel>{t("system.voiceInput.title")}</FormRowLabel>
        <FormRowDescription role={query.isError ? "alert" : undefined}>
          {query.isPending
            ? t("system.voiceInput.loading")
            : query.isError
              ? t("system.voiceInput.loadFailed")
              : place
                ? t("system.voiceInput.place", { provider: place.provider, host: place.host })
                : t("system.voiceInput.off")}
        </FormRowDescription>
      </FormRowHeading>
    </FormRow>
  );
}
