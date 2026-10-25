import { fetchAppApi } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { Card, CardContent } from "@rome-os/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rome-os/ui/select";
import { Switch } from "@rome-os/ui/switch";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { isRecapAudioSpeed, isRecapThreshold, type RecapSettings } from "../settings.js";
import "./styles.css";

const settingsKey = ["system", "recap-settings"];

async function requestSettings(next?: RecapSettings): Promise<RecapSettings> {
  const response = await fetchAppApi("settings", {
    method: next ? "PUT" : "GET",
    headers: { "Content-Type": "application/json" },
    ...(next ? { body: JSON.stringify(next) } : {}),
  });
  if (!response.ok) throw new Error("Recap settings could not be saved or loaded. Try again.");
  const data = await response.json();
  if (
    typeof data?.enabled !== "boolean" ||
    typeof data?.createAudio !== "boolean" ||
    !isRecapThreshold(data?.threshold) ||
    !isRecapAudioSpeed(data?.audioSpeed)
  ) {
    throw new Error("Recap settings returned an unexpected response. Try again.");
  }
  return data;
}

export default function App() {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <SystemSettings />
    </QueryClientProvider>
  );
}

function SystemSettings() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: settingsKey,
    queryFn: () => requestSettings(),
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: requestSettings,
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

  return (
    <main className="min-h-screen bg-app-canvas px-4 py-6 font-sans text-foreground md:px-8 md:py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-title">System</h1>
        <section aria-labelledby="recaps-heading">
          <Card>
            <CardContent className="space-y-4">
              <div className="flex items-start justify-between gap-6">
                <div className="min-w-0 space-y-2">
                  <h2 id="recaps-heading" className="text-section">
                    Spoken recaps
                  </h2>
                  <p id="recaps-description" className="text-ui text-muted-foreground">
                    A short summary after substantial chat turns, with optional audio to listen
                    hands-free. Recaps appear in the chat.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 py-2">
                  <span aria-hidden="true" className="text-aux text-muted-foreground">
                    {settings?.enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    aria-label="Spoken recaps"
                    aria-describedby="recaps-description recaps-cost"
                    checked={settings?.enabled ?? false}
                    disabled={!settings || busy}
                    onCheckedChange={(enabled) => update({ enabled })}
                  />
                </div>
              </div>
              <p
                id="recaps-cost"
                className="rounded-8 bg-surface-muted p-3 text-ui text-muted-foreground"
              >
                Each recap uses an extra model call. Off by default. Turning recaps off stops new
                summaries and audio, but keeps existing recaps.
              </p>
              <div className="border-t border-border pt-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
                  <div className="space-y-1">
                    <label id="threshold-label" className="text-ui" htmlFor="threshold">
                      Length threshold
                    </label>
                    <p id="threshold-description" className="text-ui text-muted-foreground">
                      Based on response length and tool activity, not recap length.
                    </p>
                  </div>
                  <Select
                    value={settings?.threshold ?? "medium"}
                    disabled={disabled}
                    onValueChange={(threshold) => {
                      if (isRecapThreshold(threshold)) update({ threshold });
                    }}
                  >
                    <SelectTrigger
                      id="threshold"
                      aria-labelledby="threshold-label"
                      aria-describedby="threshold-description"
                      className="w-full md:w-48 md:shrink-0"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="short">Shorter turns</SelectItem>
                      <SelectItem value="medium">Substantial turns</SelectItem>
                      <SelectItem value="long">Longer turns only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center justify-between gap-6 border-t border-border pt-4">
                <div className="space-y-1">
                  <label className="text-ui" htmlFor="create-audio">
                    Create audio
                  </label>
                  <p id="audio-description" className="text-ui text-muted-foreground">
                    Send recap text to Microsoft Edge Text to Speech to create a playable recording.
                  </p>
                </div>
                <div className="shrink-0 px-2 py-2">
                  <Switch
                    id="create-audio"
                    aria-describedby="audio-description"
                    checked={settings?.createAudio ?? false}
                    disabled={disabled}
                    onCheckedChange={(createAudio) => update({ createAudio })}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-3 border-t border-border pt-4 md:flex-row md:items-center md:justify-between md:gap-6">
                <div className="space-y-1">
                  <label id="speed-label" className="text-ui" htmlFor="audio-speed">
                    Audio speed
                  </label>
                  <p id="speed-description" className="text-ui text-muted-foreground">
                    Applies to newly created recordings.
                  </p>
                </div>
                <Select
                  value={settings?.audioSpeed ?? "faster"}
                  disabled={disabled || !settings?.createAudio}
                  onValueChange={(audioSpeed) => {
                    if (isRecapAudioSpeed(audioSpeed)) update({ audioSpeed });
                  }}
                >
                  <SelectTrigger
                    id="audio-speed"
                    aria-labelledby="speed-label"
                    aria-describedby="speed-description"
                    className="w-full md:w-48 md:shrink-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="slower">Slower (−15%)</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="faster">Faster (+15%)</SelectItem>
                    <SelectItem value="fastest">Fastest (+30%)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        </section>
        <div aria-live="polite" className="text-ui text-muted-foreground">
          {error ? (
            <div role="alert" className="flex flex-wrap items-center gap-3">
              <p>{error.message}</p>
              <Button
                variant="outline"
                disabled={busy || query.isFetching}
                onClick={() => {
                  mutation.reset();
                  void query.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          ) : query.isPending ? (
            "Loading recap settings…"
          ) : busy ? (
            "Saving…"
          ) : null}
        </div>
      </div>
    </main>
  );
}
