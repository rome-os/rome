// PROTOTYPE ONLY. Variant A: a tray docked on top of the composer. Always in view
// while you type; collapses to one line, expands upward into the full list.

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleSlash,
  CircleX,
  Loader2,
  Square,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type BgTask, type ProtoState, elapsed, statusText, stopTask } from "./store";

export function ComposerTray({ proto }: { proto: ProtoState }) {
  const [open, setOpen] = useState(false);
  if (proto.tasks.length === 0) return null;
  const running = proto.tasks.filter((t) => t.status === "running");
  const settled = proto.tasks.length - running.length;
  return (
    <div className="mx-3 rounded-t-12 border border-b-0 border-border bg-surface/95 text-aux shadow-10 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80">
      {open ? (
        <div className="max-h-72 overflow-y-auto border-b border-border px-3 py-2">
          {proto.tasks.map((t) => (
            <TrayRow key={t.id} task={t} proto={proto} />
          ))}
          <p className="pt-2 text-muted-foreground">
            Tasks keep running for up to {proto.knobs.idleCap} while this chat is idle. When one
            finishes, Rome reads the result and replies here.
          </p>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:text-foreground"
      >
        {running.length > 0 ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
        ) : (
          <CircleCheck className="size-3.5 shrink-0 text-success" />
        )}
        <span className="shrink-0 text-foreground">
          {running.length > 0
            ? `${running.length} running in the background`
            : "Background tasks done"}
          {settled > 0 ? (
            <span className="text-muted-foreground"> · {settled} finished</span>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 gap-1.5 overflow-hidden">
          {!open &&
            running.map((t) => (
              <span
                key={t.id}
                className="shrink-0 truncate rounded-full bg-surface-muted px-2 py-0.5"
              >
                {t.label} · {elapsed(t, proto.now)}
              </span>
            ))}
        </span>
        {proto.queuedResults.length > 0 ? (
          <Badge variant="info">{proto.queuedResults.length} result queued</Badge>
        ) : null}
        {open ? (
          <ChevronDown className="size-4 shrink-0" />
        ) : (
          <ChevronUp className="size-4 shrink-0" />
        )}
      </button>
    </div>
  );
}

function TrayRow({ task, proto }: { task: BgTask; proto: ProtoState }) {
  const running = task.status === "running";
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="mt-0.5 shrink-0">
        <StatusIcon task={task} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-ui text-foreground">{task.label}</span>
          {task.command ? (
            <code className="truncate font-mono text-muted-foreground">{task.command}</code>
          ) : (
            <span className="text-muted-foreground">subagent</span>
          )}
        </div>
        <div className="truncate font-mono text-muted-foreground">
          {task.outputTail.at(-1) ?? ""}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 tabular-nums",
          running ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {running ? elapsed(task, proto.now) : `${statusText(task)} · ${elapsed(task, proto.now)}`}
      </span>
      {running && proto.knobs.stopButton ? (
        <Button size="xs" variant="outline" onClick={() => stopTask(task.id)}>
          <Square className="size-3" />
          Stop
        </Button>
      ) : null}
    </div>
  );
}

function StatusIcon({ task }: { task: BgTask }) {
  if (task.status === "running") {
    return task.kind === "subagent" ? (
      <Workflow className="size-3.5 animate-pulse text-info" />
    ) : (
      <Loader2 className="size-3.5 animate-spin text-info" />
    );
  }
  if (task.status === "completed") return <CircleCheck className="size-3.5 text-success" />;
  if (task.status === "failed") return <CircleX className="size-3.5 text-destructive" />;
  return <CircleSlash className="size-3.5 text-muted-foreground" />;
}
