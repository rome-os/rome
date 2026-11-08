import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowLabel,
} from "@rome-os/ui/layout-form";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { fetchJson } from "@/lib/fetch-json";
import {
  isRecapAudioSpeed,
  isRecapThreshold,
  type RecapAudioSpeed,
  type RecapSettings,
  type RecapThreshold,
} from "../../../../rome_apps/system/src/settings";

// The System app owns these settings and validates every write; this section
// is only their editor.
const SETTINGS_URL = "/api/apps/system/settings";
const settingsKey = ["system", "recap-settings"];
const THRESHOLDS: readonly RecapThreshold[] = ["short", "medium", "long"];
const AUDIO_SPEEDS: readonly RecapAudioSpeed[] = ["slower", "normal", "faster", "fastest"];

function parseSettings(data: unknown, fallback: string): RecapSettings {
  const settings = data as Partial<RecapSettings> | null;
  if (
    typeof settings?.enabled !== "boolean" ||
    typeof settings?.createAudio !== "boolean" ||
    !isRecapThreshold(settings?.threshold) ||
    !isRecapAudioSpeed(settings?.audioSpeed)
  ) {
    throw new Error(fallback);
  }
  return settings as RecapSettings;
}

/** Rows for the Features list. The length and audio rows appear only once
 *  recaps are on, and the speed row only once audio is on. */
export function SpokenRecapsRows() {
  const { t } = useTranslation("settings");
  const uid = useId();
  const client = useQueryClient();
  const fallback = t("advanced.spokenRecaps.loadFailed");
  const query = useQuery({
    queryKey: settingsKey,
    queryFn: async ({ signal }) =>
      parseSettings(await fetchJson<unknown>(SETTINGS_URL, { signal, fallback }), fallback),
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: async (next: RecapSettings) =>
      parseSettings(
        await fetchJson<unknown>(SETTINGS_URL, {
          method: "PUT",
          json: next,
          fallback,
        }),
        fallback,
      ),
    onSuccess: async (settings) => {
      client.setQueryData(settingsKey, settings);
      await client.invalidateQueries({ queryKey: settingsKey });
    },
  });
  const settings = query.data;
  const busy = mutation.isPending;
  const disabled = !settings?.enabled || busy;
  const error = mutation.error ?? query.error;

  function update(patch: Partial<RecapSettings>) {
    if (settings && !busy) mutation.mutate({ ...settings, ...patch });
  }

  const status = error ? (
    <span role="alert" className="inline-flex flex-wrap items-center gap-2 text-destructive-fg">
      {fallback}
      <Button
        variant="outline"
        size="xs"
        disabled={busy || query.isFetching}
        onClick={() => {
          mutation.reset();
          void query.refetch();
        }}
      >
        {t("advanced.spokenRecaps.retry")}
      </Button>
    </span>
  ) : query.isPending ? (
    t("advanced.spokenRecaps.loading")
  ) : busy ? (
    t("advanced.spokenRecaps.saving")
  ) : (
    t("advanced.spokenRecaps.description")
  );

  return (
    <>
      <FormRow>
        <FormRowHeading>
          <FormRowLabel htmlFor={`${uid}-enabled`}>{t("advanced.spokenRecaps.title")}</FormRowLabel>
          <FormRowDescription aria-live="polite">{status}</FormRowDescription>
        </FormRowHeading>
        <FormRowControl>
          <Switch
            id={`${uid}-enabled`}
            aria-label={t("advanced.spokenRecaps.enabled.title")}
            checked={settings?.enabled ?? false}
            disabled={!settings || busy}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </FormRowControl>
      </FormRow>
      {settings?.enabled && (
        <>
          <FormRow>
            <FormRowHeading>
              <FormRowLabel htmlFor={`${uid}-threshold`}>
                {t("advanced.spokenRecaps.threshold.title")}
              </FormRowLabel>
            </FormRowHeading>
            <FormRowControl>
              <Select
                value={settings?.threshold ?? "medium"}
                disabled={disabled}
                onValueChange={(threshold) => {
                  if (isRecapThreshold(threshold)) update({ threshold });
                }}
              >
                <SelectTrigger
                  id={`${uid}-threshold`}
                  aria-label={t("advanced.spokenRecaps.threshold.title")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {THRESHOLDS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`advanced.spokenRecaps.threshold.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormRowControl>
          </FormRow>
          <FormRow>
            <FormRowHeading>
              <FormRowLabel htmlFor={`${uid}-audio`}>
                {t("advanced.spokenRecaps.createAudio.title")}
              </FormRowLabel>
              <FormRowDescription>
                {t("advanced.spokenRecaps.createAudio.description")}
              </FormRowDescription>
            </FormRowHeading>
            <FormRowControl>
              <Switch
                id={`${uid}-audio`}
                aria-label={t("advanced.spokenRecaps.createAudio.title")}
                checked={settings?.createAudio ?? false}
                disabled={disabled}
                onCheckedChange={(createAudio) => update({ createAudio })}
              />
            </FormRowControl>
          </FormRow>
          {settings.createAudio && (
            <FormRow>
              <FormRowHeading>
                <FormRowLabel htmlFor={`${uid}-speed`}>
                  {t("advanced.spokenRecaps.audioSpeed.title")}
                </FormRowLabel>
              </FormRowHeading>
              <FormRowControl>
                <Select
                  value={settings?.audioSpeed ?? "faster"}
                  disabled={disabled || !settings?.createAudio}
                  onValueChange={(audioSpeed) => {
                    if (isRecapAudioSpeed(audioSpeed)) update({ audioSpeed });
                  }}
                >
                  <SelectTrigger
                    id={`${uid}-speed`}
                    aria-label={t("advanced.spokenRecaps.audioSpeed.title")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    {AUDIO_SPEEDS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`advanced.spokenRecaps.audioSpeed.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormRowControl>
            </FormRow>
          )}
        </>
      )}
    </>
  );
}
