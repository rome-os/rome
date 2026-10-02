// PROTOTYPE ONLY. Variant B: a status pill in the chat header that opens a
// popover. Takes no room from the transcript or the composer; you look when you
// want to.

import { CircleCheck, CircleSlash, CircleX, Loader2, Square, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { type BgTask, type ProtoState, elapsed, statusText, stopTask } from "./store";

export function HeaderIndicator({ proto }: { proto: ProtoState }) {
  if (proto.tasks.length === 0) return null;
  const running = proto.tasks.filter((t) => t.status === "running");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "relative mr-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-aux",
            running.length > 0
              ? "border-info/40 bg-info-bg text-info-fg"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {running.length > 0 ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <CircleCheck className="size-3.5" />
          )}
          {running.length > 0 ? `${running.length} running` : "Tasks done"}
          {proto.queuedResults.length > 0 ? (
            <span
              className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-info"
              title="A finished task's result is queued"
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] p-0">
        <div className="border-b border-border px-4 py-2.5">
          <div className="text-ui text-foreground">Background tasks</div>
          <div className="text-aux text-muted-foreground">
            {proto.queuedResults.length > 0
              ? "A finished task is queued. Rome reads it when the current reply ends."
              : "When one finishes, Rome reads the result and replies in the chat."}
          </div>
        </div>
        <ul className="max-h-80 divide-y divide-border overflow-y-auto">
          {proto.tasks.map((t) => (
            <PopoverRow key={t.id} task={t} proto={proto} />
          ))}
        </ul>
        <div className="border-t border-border px-4 py-2 text-aux text-muted-foreground">
          Keeps running for up to {proto.knobs.idleCap} while this chat is idle.
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PopoverRow({ task, proto }: { task: BgTask; proto: ProtoState }) {
  const running = task.status === "running";
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-2">
        <Icon task={task} />
        <span className="min-w-0 flex-1 truncate text-ui text-foreground">{task.label}</span>
        <span className="shrink-0 text-aux tabular-nums text-muted-foreground">
          {running ? elapsed(task, proto.now) : statusText(task)}
        </span>
        {running && proto.knobs.stopButton ? (
          <Button size="xs" variant="ghost" onClick={() => stopTask(task.id)} aria-label="Stop">
            <Square className="size-3" />
          </Button>
        ) : null}
      </div>
      <div className="mt-1 pl-5.5 text-aux text-muted-foreground">
        {task.command ? <code className="font-mono">{task.command}</code> : "Subagent"}
      </div>
      <pre className="mt-1.5 ml-5.5 overflow-hidden rounded-8 bg-surface-muted px-2 py-1 font-mono text-aux text-muted-foreground">
        {task.outputTail.slice(-2).join("\n")}
      </pre>
    </li>
  );
}

function Icon({ task }: { task: BgTask }) {
  if (task.status === "running") {
    return task.kind === "subagent" ? (
      <Workflow className="size-3.5 shrink-0 animate-pulse text-info" />
    ) : (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-info" />
    );
  }
  if (task.status === "completed")
    return <CircleCheck className="size-3.5 shrink-0 text-success" />;
  if (task.status === "failed") return <CircleX className="size-3.5 shrink-0 text-destructive" />;
  return <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />;
}
