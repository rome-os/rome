// PROTOTYPE ONLY. The scripted end of the conversation, rendered with the real
// transcript rows. Every variant shows the same tail, so the variants differ only
// in where the task list lives. The "task finished" marker is part of the
// question too: it is how a turn that Rome started, with no user message, reads.

import type { ReactNode } from "react";
import { CircleCheck, CircleX, Workflow } from "lucide-react";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import Markdown from "@/components/chat/ChatMarkdown";
import { MessageRow } from "@/components/chat/MessageRow";
import { UserMessage } from "@/components/chat/UserMessage";
import { cn } from "@/lib/utils";
import { type BgTask, type ProtoState, elapsed, statusText } from "./store";

export function TranscriptTail({
  proto,
  renderStartedTasks,
}: {
  proto: ProtoState;
  /** Variant C puts live task cards under the reply that started the tasks. */
  renderStartedTasks?: (taskIds: string[]) => ReactNode;
}) {
  const avatar = <AgentAvatar label="Rome" />;
  const rows: ReactNode[] = [];
  const items = proto.transcript;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === "user") {
      rows.push(
        <UserMessage
          key={item.id}
          msg={{
            id: item.id,
            sessionId: "prototype",
            role: "user",
            content: JSON.stringify([{ type: "text", content: item.text }]),
            createdAt: new Date().toISOString(),
            inputState: item.state === "queued" ? "queued" : "consumed",
          }}
        />,
      );
      if (item.state === "queued") {
        rows.push(
          <div
            key={`${item.id}-q`}
            className="-mt-3 mb-4 text-right text-aux text-muted-foreground"
          >
            Rome reads this after it finishes the current reply
          </div>,
        );
      }
      continue;
    }
    if (item.kind === "marker") {
      const tasks = item.taskIds
        .map((id) => proto.tasks.find((t) => t.id === id))
        .filter((t): t is BgTask => !!t);
      rows.push(<FinishedMarker key={item.id} tasks={tasks} now={proto.now} />);
      // The reply that follows a marker belongs to the Rome-started turn.
      const reply = items[i + 1];
      if (item.silent) {
        rows.push(
          <MessageRow
            key={`${item.id}-silent`}
            name="Rome"
            avatar={avatar}
            subtitle={<StartedByRome />}
          >
            <p className="text-ui text-muted-foreground">
              {item.settled
                ? "Read the result. Nothing needs your attention."
                : "Reading the result…"}
            </p>
          </MessageRow>,
        );
      } else if (reply?.kind === "agent") {
        i++;
        rows.push(
          <MessageRow key={reply.id} name="Rome" avatar={avatar} subtitle={<StartedByRome />}>
            <AgentText text={reply.text} streaming={reply.streaming} />
          </MessageRow>,
        );
      }
      continue;
    }
    rows.push(
      <MessageRow key={item.id} name="Rome" avatar={avatar}>
        <AgentText text={item.text} streaming={item.streaming} />
        {item.startsTasks && renderStartedTasks ? renderStartedTasks(item.startsTasks) : null}
      </MessageRow>,
    );
  }
  return (
    <div className="mx-auto max-w-5xl px-4 md:px-6">
      <div className="mb-6 mt-2 flex items-center gap-3 text-aux text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        prototype conversation continues below
        <span className="h-px flex-1 bg-border" />
      </div>
      {rows}
    </div>
  );
}

function AgentText({ text, streaming }: { text: string; streaming: boolean }) {
  if (!text && streaming) {
    return <p className="animate-pulse text-ui text-muted-foreground">Thinking…</p>;
  }
  return (
    <Markdown className={cn("min-w-0 text-foreground", streaming && "opacity-90")} compact={false}>
      {text}
    </Markdown>
  );
}

function StartedByRome() {
  return (
    <span className="text-aux text-muted-foreground">Started by Rome · no message from you</span>
  );
}

function FinishedMarker({ tasks, now }: { tasks: BgTask[]; now: number }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      {tasks.map((t) => {
        const ok = t.status === "completed";
        return (
          <span
            key={t.id}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-aux",
              ok
                ? "border-success/40 text-success-fg"
                : "border-destructive/40 text-destructive-fg",
            )}
          >
            {t.kind === "subagent" ? (
              <Workflow className="size-3.5" />
            ) : ok ? (
              <CircleCheck className="size-3.5" />
            ) : (
              <CircleX className="size-3.5" />
            )}
            Background task finished · {t.label} · {statusText(t)} · {elapsed(t, now)}
          </span>
        );
      })}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
