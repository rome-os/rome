import "./styles.css";
import { useCallback, useEffect, useState } from "react";
import { fetchAppApi, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { ScrollText, Radar, FileText, Settings2, X, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScoutsPanel } from "./components/ScoutsPanel";
import { BriefsPanel } from "./components/BriefsPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import type { ScoutDraft } from "./components/ScoutForm";
import { fetchChannelConnectivity, type ChannelConnectivity } from "./lib/channels";
import type { SettingsDto, StateDto } from "./lib/types";
import { cn } from "@/lib/utils";

type Tab = "scouts" | "briefs" | "settings";

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

// The daily brief document is the app's main page, so it comes first.
const TABS: { id: Tab; label: string; icon: typeof Radar }[] = [
  { id: "briefs", label: "Daily Brief", icon: FileText },
  { id: "scouts", label: "Scouts", icon: Radar },
  { id: "settings", label: "Settings", icon: Settings2 },
];

export default function App({ bootstrap: _bootstrap }: { bootstrap: RomeAppBootstrap }) {
  const [state, setState] = useState<StateDto | null>(null);
  const [connectivity, setConnectivity] = useState<ChannelConnectivity | null>(null);
  const [tab, setTab] = useState<Tab>("briefs");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyScoutId, setBusyScoutId] = useState<string | null>(null);
  const [creatingScout, setCreatingScout] = useState(false);
  const [runningBrief, setRunningBrief] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const loadState = useCallback(async () => {
    const res = await fetchAppApi("state");
    if (!res.ok) throw new Error(await readError(res));
    setState((await res.json()) as StateDto);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadState();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [loadState]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await loadState();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
      setConnectivity(await fetchChannelConnectivity());
    })();
  }, [loadState]);

  const createScout = async (draft: ScoutDraft) => {
    setCreatingScout(true);
    setError(null);
    try {
      const res = await fetchAppApi("scouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingScout(false);
    }
  };

  const updateScout = async (id: string, draft: ScoutDraft) => {
    setBusyScoutId(id);
    setError(null);
    try {
      const res = await fetchAppApi(`scouts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyScoutId(null);
    }
  };

  const deleteScout = async (id: string) => {
    setBusyScoutId(id);
    setError(null);
    try {
      const res = await fetchAppApi(`scouts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyScoutId(null);
    }
  };

  const runScout = async (id: string) => {
    setBusyScoutId(id);
    setError(null);
    try {
      const res = await fetchAppApi(`scouts/${id}/run`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyScoutId(null);
    }
  };

  const runTestBrief = async (deliver: boolean) => {
    setRunningBrief(true);
    setError(null);
    try {
      const res = await fetchAppApi("briefs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "test", deliver }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningBrief(false);
    }
  };

  const saveSettings = async (next: SettingsDto): Promise<string | null> => {
    setSavingSettings(true);
    try {
      const res = await fetchAppApi("settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) return await readError(res);
      const data = (await res.json()) as { settings: SettingsDto; routineSyncError?: string };
      await loadState();
      return data.routineSyncError ?? null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <main
      className={cn(
        "mx-auto w-full px-4 py-6 md:px-6",
        tab === "briefs" ? "max-w-5xl" : "max-w-3xl",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ScrollText className="size-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Briefing</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : undefined} /> Refresh
        </Button>
      </header>
      <p className="mt-1 text-sm text-muted-foreground">
        Scheduled morning and evening briefings, woven from your calendar, recent messages, and
        recurring scouting tasks.
      </p>

      <div className="mt-4 inline-flex rounded-8 border bg-muted/40 p-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-8 px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-1"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 flex items-start justify-between gap-2 rounded-8 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="mt-5">
        {loading || !state ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : tab === "scouts" ? (
          <ScoutsPanel
            scouts={state.scouts}
            intervalOptions={state.meta.intervalOptions}
            busyId={busyScoutId}
            creating={creatingScout}
            onCreate={createScout}
            onUpdate={updateScout}
            onDelete={deleteScout}
            onRun={runScout}
          />
        ) : tab === "briefs" ? (
          <BriefsPanel
            briefs={state.briefs}
            settings={state.settings}
            running={runningBrief}
            onRunTest={runTestBrief}
          />
        ) : (
          <SettingsPanel
            settings={state.settings}
            connectivity={connectivity}
            saving={savingSettings}
            onSave={saveSettings}
          />
        )}
      </div>
    </main>
  );
}
