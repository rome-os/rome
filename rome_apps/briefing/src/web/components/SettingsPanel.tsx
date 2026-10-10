import { useEffect, useState } from "react";
import { Save, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SettingsDto } from "../lib/types";
import type { ChannelConnectivity } from "../lib/channels";

export function SettingsPanel({
  settings,
  connectivity,
  saving,
  onSave,
}: {
  settings: SettingsDto;
  connectivity: ChannelConnectivity | null;
  saving: boolean;
  onSave: (next: SettingsDto) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<SettingsDto>(settings);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => setDraft(settings), [settings]);

  const set = <K extends keyof SettingsDto>(key: K, value: SettingsDto[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const whatsappUnavailable = draft.channel === "whatsapp" && connectivity?.whatsapp === false;

  const save = async () => {
    setMessage(null);
    const err = await onSave(draft);
    setMessage(err ? { kind: "err", text: err } : { kind: "ok", text: "Settings saved." });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="channel">Send briefs via</Label>
            <Select value={draft.channel} onValueChange={(v) => set("channel", v)}>
              <SelectTrigger id="channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {draft.channel === "email" ? (
            <div className="grid gap-2 sm:max-w-md">
              <Label htmlFor="email-to">Recipient</Label>
              <Input
                id="email-to"
                value={draft.emailTo}
                placeholder="guardian"
                onChange={(e) => set("emailTo", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Use <code>guardian</code> to send to your own address, or enter any email.
              </p>
            </div>
          ) : (
            <div className="grid gap-2 sm:max-w-md">
              <Label htmlFor="wa-thread">WhatsApp chat id (optional)</Label>
              <Input
                id="wa-thread"
                value={draft.whatsappThreadId}
                placeholder="Leave blank to send to your own WhatsApp"
                onChange={(e) => set("whatsappThreadId", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to deliver to your own WhatsApp automatically. Only set a chat id to
                send briefs to a different chat (e.g. <code>14155551234@s.whatsapp.net</code>).
              </p>
              {whatsappUnavailable && (
                <p className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="size-3" /> WhatsApp isn’t connected yet — connect it in
                  Settings → Channels, or briefs will fail to send.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="tz">Timezone</Label>
            <Input
              id="tz"
              value={draft.timezone}
              placeholder="America/Los_Angeles"
              onChange={(e) => set("timezone", e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-8 border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Switch
                id="morning"
                checked={draft.morningEnabled}
                onCheckedChange={(v) => set("morningEnabled", v)}
              />
              <Label htmlFor="morning">Morning brief</Label>
            </div>
            <Input
              type="time"
              className="sm:max-w-[8rem]"
              value={draft.morningTime}
              onChange={(e) => set("morningTime", e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-8 border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Switch
                id="evening"
                checked={draft.eveningEnabled}
                onCheckedChange={(v) => set("eveningEnabled", v)}
              />
              <Label htmlFor="evening">Evening brief</Label>
            </div>
            <Input
              type="time"
              className="sm:max-w-[8rem]"
              value={draft.eveningTime}
              onChange={(e) => set("eveningTime", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {message && (
          <span
            className={
              message.kind === "ok"
                ? "inline-flex items-center gap-1 text-sm text-muted-foreground"
                : "inline-flex items-center gap-1 text-sm text-destructive"
            }
          >
            {message.kind === "ok" ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <AlertTriangle className="size-4" />
            )}
            {message.text}
          </span>
        )}
        <Button onClick={() => void save()} disabled={saving}>
          <Save className={saving ? "animate-pulse" : undefined} />
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
