import { useState } from "react";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { BriefBook } from "./BriefBook";
import type { BriefDto, SettingsDto } from "../lib/types";

export function BriefsPanel({
  briefs,
  settings,
  running,
  onRunTest,
}: {
  briefs: BriefDto[];
  settings: SettingsDto;
  running: boolean;
  onRunTest: (deliver: boolean) => Promise<void>;
}) {
  const [deliver, setDeliver] = useState(true);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Daily brief</h2>
          <p className="text-sm text-muted-foreground">
            One document per day — action items and an executive summary up front, the full briefs
            behind. Step between days, or pick a date.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch id="deliver" checked={deliver} onCheckedChange={setDeliver} />
            <Label htmlFor="deliver" className="whitespace-nowrap">
              Send to {settings.channel}
            </Label>
          </div>
          <Button onClick={() => void onRunTest(deliver)} disabled={running}>
            <PlayCircle className={running ? "animate-pulse" : undefined} />
            {running ? "Preparing…" : "Run test brief"}
          </Button>
        </div>
      </div>

      <BriefBook briefs={briefs} timezone={settings.timezone} />
    </div>
  );
}
