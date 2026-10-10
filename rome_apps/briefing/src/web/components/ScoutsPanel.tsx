import { useState } from "react";
import {
  Plus,
  Play,
  Pencil,
  Trash2,
  Clock,
  ChevronDown,
  ChevronRight,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScoutForm, type ScoutDraft } from "./ScoutForm";
import { ScoutHistory } from "./ScoutHistory";
import { StatusBadge } from "./StatusBadge";
import { intervalLabel, timeAgo } from "../lib/format";
import type { IntervalOption, ScoutDto } from "../lib/types";

export function ScoutsPanel({
  scouts,
  intervalOptions,
  busyId,
  creating,
  onCreate,
  onUpdate,
  onDelete,
  onRun,
}: {
  scouts: ScoutDto[];
  intervalOptions: IntervalOption[];
  busyId: string | null;
  creating: boolean;
  onCreate: (draft: ScoutDraft) => Promise<void>;
  onUpdate: (id: string, draft: ScoutDraft) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRun: (id: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-medium">Scouting tasks</h2>
          <p className="text-sm text-muted-foreground">
            Detailed prompts the assistant runs on a schedule. Findings feed your briefs.
          </p>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add scout
          </Button>
        )}
      </div>

      {adding && (
        <ScoutForm
          intervalOptions={intervalOptions}
          submitLabel="Add scout"
          busy={creating}
          onCancel={() => setAdding(false)}
          onSubmit={async (draft) => {
            await onCreate(draft);
            setAdding(false);
          }}
        />
      )}

      {scouts.length === 0 && !adding ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No scouting tasks yet. Add one to have the assistant watch something for you on a
            schedule.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {scouts.map((s) => {
            const editing = editingId === s.id;
            const expanded = expandedId === s.id;
            const busy = busyId === s.id;
            if (editing) {
              return (
                <ScoutForm
                  key={s.id}
                  initial={s}
                  intervalOptions={intervalOptions}
                  submitLabel="Save changes"
                  busy={busy}
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (draft) => {
                    await onUpdate(s.id, draft);
                    setEditingId(null);
                  }}
                />
              );
            }
            return (
              <Card key={s.id}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{s.title}</span>
                        {s.enabled ? (
                          <Badge variant="secondary">active</Badge>
                        ) : (
                          <Badge variant="muted">paused</Badge>
                        )}
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="size-3" />{" "}
                          {intervalLabel(s.intervalMinutes, intervalOptions)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-sm text-muted-foreground">{s.prompt}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Run now"
                        disabled={busy}
                        onClick={() => void onRun(s.id)}
                      >
                        <Play className={busy ? "animate-pulse" : undefined} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Edit"
                        onClick={() => setEditingId(s.id)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Delete"
                        onClick={() => void onDelete(s.id)}
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
                    <span>Last run {timeAgo(s.lastRunAt)}</span>
                    {s.latestResult && (
                      <>
                        <span>·</span>
                        <StatusBadge status={s.latestResult.status} />
                      </>
                    )}
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-foreground hover:underline"
                      onClick={() => setExpandedId(expanded ? null : s.id)}
                    >
                      {expanded ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                      <History className="size-3" /> findings & history
                    </button>
                  </div>

                  {expanded && (
                    <ScoutHistory key={`${s.id}:${s.lastRunAt ?? "never"}`} scoutId={s.id} />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
