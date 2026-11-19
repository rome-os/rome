import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@rome-os/ui/select";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { IntervalOption, ScoutDto } from "../lib/types";

export interface ScoutDraft {
  title: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
}

export function ScoutForm({
  initial,
  intervalOptions,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  initial?: ScoutDto;
  intervalOptions: IntervalOption[];
  submitLabel: string;
  busy: boolean;
  onSubmit: (draft: ScoutDraft) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [intervalMinutes, setIntervalMinutes] = useState(initial?.intervalMinutes ?? 360);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const canSubmit = title.trim().length > 0 && prompt.trim().length > 0 && !busy;

  return (
    <div className="space-y-4 rounded-12 border bg-muted/30 p-4">
      <div className="grid gap-2">
        <Label htmlFor="scout-title">Title</Label>
        <Input
          id="scout-title"
          placeholder="e.g. Hacker News watch"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="scout-prompt">Task prompt</Label>
        <Textarea
          id="scout-prompt"
          rows={5}
          placeholder="Describe in detail what the assistant should look for and how to report it. e.g. 'Search Hacker News for new posts mentioning Rome or AI agents in the last 6 hours. List the top 5 with title, link, and a one-line why-it-matters.'"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          This exact prompt is handed to the assistant agent as its task each run.
        </p>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-2 sm:max-w-xs sm:flex-1">
          <Label htmlFor="scout-interval">Run interval</Label>
          <Select
            value={String(intervalMinutes)}
            onValueChange={(v) => setIntervalMinutes(Number(v))}
          >
            <SelectTrigger id="scout-interval" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {intervalOptions.map((o) => (
                <SelectItem key={o.minutes} value={String(o.minutes)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="scout-enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="scout-enabled">Enabled</Label>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() =>
            onSubmit({ title: title.trim(), prompt: prompt.trim(), intervalMinutes, enabled })
          }
          disabled={!canSubmit}
        >
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
