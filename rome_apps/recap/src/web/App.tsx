import { useEffect, useState } from "react";
import { fetchAppApi, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { Gauge, RefreshCw, Volume2 } from "lucide-react";
import "./styles.css";

type RecapThreshold = "short" | "medium" | "long";
type RecapAudioSpeed = "slower" | "normal" | "faster" | "fastest";

interface RecapSettings {
  enabled: boolean;
  createAudio: boolean;
  threshold: RecapThreshold;
  audioSpeed: RecapAudioSpeed;
}

const thresholdOptions: RecapThreshold[] = ["short", "medium", "long"];
const audioSpeedOptions: RecapAudioSpeed[] = ["slower", "normal", "faster", "fastest"];
const audioSpeedLabels: Record<RecapAudioSpeed, string> = {
  slower: "slower -15%",
  normal: "normal",
  faster: "faster 15%",
  fastest: "fastest 30%",
};

export default function RecapApp({ bootstrap }: { bootstrap: RomeAppBootstrap }) {
  const [settings, setSettings] = useState<RecapSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchAppApi("settings", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Settings request failed with ${response.status}`);
      setSettings((await response.json()) as RecapSettings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function updateSettings(nextSettings: RecapSettings) {
    if (!settings || saving) return;
    const previous = settings;
    setSettings(nextSettings);
    setSaving(true);
    setError(null);

    try {
      const response = await fetchAppApi("settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(nextSettings),
      });
      if (!response.ok) throw new Error(`Settings update failed with ${response.status}`);
      setSettings((await response.json()) as RecapSettings);
    } catch (err) {
      setSettings(previous);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function updateEnabled(enabled: boolean) {
    if (!settings) return;
    await updateSettings({ ...settings, enabled });
  }

  async function updateCreateAudio(createAudio: boolean) {
    if (!settings) return;
    await updateSettings({ ...settings, createAudio });
  }

  async function updateThreshold(threshold: RecapThreshold) {
    if (!settings || settings.threshold === threshold) return;
    await updateSettings({ ...settings, threshold });
  }

  async function updateAudioSpeed(audioSpeed: RecapAudioSpeed) {
    if (!settings || settings.audioSpeed === audioSpeed) return;
    await updateSettings({ ...settings, audioSpeed });
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  const recapsEnabled = settings?.enabled === true;
  const audioEnabled = settings?.createAudio === true;
  const selectedThreshold = settings?.threshold ?? "medium";
  const selectedAudioSpeed = settings?.audioSpeed ?? "faster";

  const panelClass =
    "flex items-center justify-between gap-6 rounded-12 border border-border bg-surface p-5 shadow-1 max-md:flex-col max-md:items-stretch";
  const segmentClass = (selected: boolean) =>
    `min-h-9 rounded-8 px-3 font-bold capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
      selected
        ? "bg-primary text-primary-foreground shadow-1"
        : "text-surface-muted-foreground hover:text-surface-foreground"
    }`;

  return (
    <main className="min-h-screen bg-background p-7 font-sans text-foreground max-md:p-[18px]">
      <div className="mx-auto max-w-[880px]">
        <header className="mb-6 flex items-center justify-between gap-4 max-md:items-stretch">
          <div className="flex items-center gap-3.5">
            <div
              className="grid size-12 place-items-center rounded-8 bg-brand text-brand-fg"
              aria-hidden="true"
            >
              <Volume2 size={22} />
            </div>
            <div>
              <p className="mb-1 text-xs font-bold uppercase text-muted-foreground">Turn recaps</p>
              <h1 className="text-3xl leading-tight">Spoken WebChat briefings</h1>
            </div>
          </div>
          <button
            className="grid size-10 shrink-0 place-items-center rounded-8 border border-border bg-surface text-surface-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-55"
            type="button"
            aria-label="Refresh settings"
            title="Refresh settings"
            onClick={() => void loadSettings()}
            disabled={loading || saving}
          >
            <RefreshCw size={18} className={loading ? "animate-spin" : undefined} />
          </button>
        </header>

        <div className="space-y-4">
          <section className={panelClass}>
            <div className="min-w-0">
              <h2 className="mb-2 text-section font-semibold">Recaps</h2>
              <p className="max-w-[560px] leading-relaxed text-muted-foreground">
                Save a recap after each substantial WebChat turn. Each recap runs an extra model
                call.
              </p>
            </div>

            <Switch
              checked={recapsEnabled}
              disabled={!settings || saving}
              onLabel="Recaps on"
              offLabel="Recaps off"
              onToggle={() => void updateEnabled(!recapsEnabled)}
            />
          </section>

          {recapsEnabled && (
            <>
              <section className={panelClass}>
                <div className="min-w-0">
                  <h2 className="mb-2 text-section font-semibold">Audio generation</h2>
                  <p className="max-w-[560px] leading-relaxed text-muted-foreground">
                    Also save each recap as audio, spoken with Edge Text to Speech.
                  </p>
                </div>

                <Switch
                  checked={audioEnabled}
                  disabled={!settings || saving}
                  onLabel="Audio on"
                  offLabel="Audio off"
                  onToggle={() => void updateCreateAudio(!audioEnabled)}
                />
              </section>

              {audioEnabled && (
                <section className={panelClass}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Gauge size={18} aria-hidden="true" />
                      <h2 className="text-section font-semibold">Audio speed</h2>
                    </div>
                    <p className="leading-relaxed text-muted-foreground">
                      Set the speaking pace for newly generated recap audio.
                    </p>
                  </div>

                  <div
                    className="grid min-w-[260px] shrink-0 grid-cols-3 gap-1 rounded-8 border border-border bg-surface-muted p-1 max-md:w-full max-md:min-w-0"
                    role="group"
                    aria-label="Audio speed"
                  >
                    {audioSpeedOptions.map((audioSpeed) => (
                      <button
                        key={audioSpeed}
                        type="button"
                        className={segmentClass(audioSpeed === selectedAudioSpeed)}
                        disabled={!settings || saving}
                        onClick={() => void updateAudioSpeed(audioSpeed)}
                      >
                        {audioSpeedLabels[audioSpeed]}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section className={panelClass}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Gauge size={18} aria-hidden="true" />
                    <h2 className="text-section font-semibold">Recap threshold</h2>
                  </div>
                  <p className="leading-relaxed text-muted-foreground">
                    Choose how substantial a completed WebChat turn should be before saving a recap.
                  </p>
                </div>

                <div
                  className="grid min-w-[260px] shrink-0 grid-cols-3 gap-1 rounded-8 border border-border bg-surface-muted p-1 max-md:w-full max-md:min-w-0"
                  role="group"
                  aria-label="Recap threshold"
                >
                  {thresholdOptions.map((threshold) => (
                    <button
                      key={threshold}
                      type="button"
                      className={segmentClass(threshold === selectedThreshold)}
                      disabled={!settings || saving}
                      onClick={() => void updateThreshold(threshold)}
                    >
                      {threshold}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>

        <section className="mt-[18px] grid grid-cols-3 gap-px overflow-hidden rounded-12 border border-border bg-border max-md:grid-cols-1">
          {[
            { label: "Status", value: loading ? "Loading" : saving ? "Saving" : "Ready" },
            { label: "App", value: bootstrap.appId },
            { label: "Version", value: bootstrap.version },
          ].map((cell) => (
            <div key={cell.label} className="min-w-0 bg-surface p-4">
              <span className="mb-1 block text-xs text-muted-foreground">{cell.label}</span>
              <strong className="block break-words">{cell.value}</strong>
            </div>
          ))}
        </section>

        {error && (
          <p className="mt-[18px] rounded-12 border border-destructive-border bg-destructive-bg px-3.5 py-3 text-destructive-fg">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

function Switch({
  checked,
  disabled,
  onLabel,
  offLabel,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  onLabel: string;
  offLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      className="inline-flex min-w-[132px] shrink-0 items-center gap-2.5 rounded-8 border border-border bg-surface-muted px-2.5 py-2 font-bold text-surface-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-60 max-md:justify-between"
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
    >
      <span
        className={`relative inline-flex h-6 w-[42px] rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-border-strong"
        }`}
      >
        <span
          className={`absolute left-[3px] top-[3px] size-[18px] rounded-full bg-surface shadow transition-transform ${
            checked ? "translate-x-[18px]" : ""
          }`}
        />
      </span>
      <span>{checked ? onLabel : offLabel}</span>
    </button>
  );
}
