// PROTOTYPE ONLY. Variant C: live cards in the transcript, under the reply that
// started each task. No chrome outside the conversation; once the cards scroll
// out of view, nothing on screen says tasks are running.

import { CircleCheck, CircleSlash, CircleX, Loader2, Square, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type BgTask, type ProtoState, elapsed, statusText, stopTask } from "./store";

export function InlineTaskCards({ proto, taskIds }: { proto: ProtoState; taskIds: string[] }) {
  const tasks = taskIds
    .map((id) => proto.tasks.find((t) => t.id === id))
    .filter((t): t is BgTask => !!t);
  return (
    <div className="mt-3 grid gap-2 @min-[44rem]/transcript:grid-cols-2">
      {tasks.map((t) => (
        <InlineCard key={t.id} task={t} proto={proto} />
      ))}
      <p className="text-aux text-muted-foreground @min-[44rem]/transcript:col-span-2">
        Running in the background · kept alive up to {proto.knobs.idleCap} while this chat is idle
      </p>
    </div>
  );
}

function InlineCard({ task, proto }: { task: BgTask; proto: ProtoState }) {
  const running = task.status === "running";
  const queued = proto.queuedResults.includes(task.id);
  return (
    <div
      className={cn(
        "rounded-12 border bg-surface px-3 py-2.5",
        running
          ? "border-info/40"
          : task.status === "failed"
            ? "border-destructive/40"
            : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <CardIcon task={task} />
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">{task.label}</span>
        <span className="shrink-0 text-aux tabular-nums text-muted-foreground">
          {running ? elapsed(task, proto.now) : `${statusText(task)} · ${elapsed(task, proto.now)}`}
        </span>
        {running && proto.knobs.stopButton ? (
          <Button size="xs" variant="outline" onClick={() => stopTask(task.id)}>
            <Square className="size-3" />
            Stop
          </Button>
        ) : null}
      </div>
      <div className="mt-1 truncate text-aux text-muted-foreground">
        {task.command ? <code className="font-mono">{task.command}</code> : "Subagent"}
      </div>
      <pre className="mt-2 overflow-hidden rounded-8 bg-surface-muted px-2 py-1.5 font-mono text-aux leading-relaxed text-muted-foreground">
        {task.outputTail.join("\n")}
      </pre>
      {queued ? (
        <div className="mt-2 text-aux text-info-fg">
          Result queued · Rome reads it after the current reply
        </div>
      ) : task.reported && task.status !== "stopped" ? (
        <div className="mt-2 text-aux text-muted-foreground">Rome reported this below ↓</div>
      ) : null}
    </div>
  );
}

function CardIcon({ task }: { task: BgTask }) {
  if (task.status === "running") {
    return task.kind === "subagent" ? (
      <Workflow className="size-4 shrink-0 animate-pulse text-info" />
    ) : (
      <Loader2 className="size-4 shrink-0 animate-spin text-info" />
    );
  }
  if (task.status === "completed") return <CircleCheck className="size-4 shrink-0 text-success" />;
  if (task.status === "failed") return <CircleX className="size-4 shrink-0 text-destructive" />;
  return <CircleSlash className="size-4 shrink-0 text-muted-foreground" />;
}
