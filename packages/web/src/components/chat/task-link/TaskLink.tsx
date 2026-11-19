// A link to a task chat in the Concierge's message, drawn as a chip
// (docs/domains/chats.md#task-link): the task chat's status mark and its
// current name, in the inline code's tint. The status word is in the tooltip
// and the screen reader's label, never on the chip. It opens the task chat.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ConciergeTaskStatusResult } from "@rome/api-types/concierge-task-status";
import { TaskGlyph } from "@/components/concierge/TaskGlyph";
import { useTaskLink } from "./task-links";

/** The word for a task chat's status, as the chip's tooltip and label say it. */
export function taskStatusKey({ status, endReason }: ConciergeTaskStatusResult): string {
  return status === "ended" ? (endReason ?? "done") : status;
}

/**
 * The chip for task chat `id`, with its live name, else `fallback`, the link's
 * own text. A task chat that is not this Concierge chat's own reads as plain
 * text, and so does a link outside a Concierge chat.
 */
export function TaskLink({ id, fallback }: { id: string; fallback?: string }) {
  const { t } = useTranslation("chat");
  const link = useTaskLink(id);
  const key = link.state === "found" ? taskStatusKey(link.task) : null;
  // A status change flashes the tint once, nothing louder.
  const [flash, setFlash] = useState(false);
  const last = useRef(key);
  useEffect(() => {
    const before = last.current;
    last.current = key;
    if (before === null || key === null || before === key) return;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 700);
    return () => window.clearTimeout(timer);
  }, [key]);
  const name = link.state === "found" ? link.task.name.trim() || fallback : fallback;
  const label = name || t("taskLink.untitled");
  if (link.state === "none") return <>{label}</>;
  const status = link.state === "found" ? link.task : null;
  const word = key ? t(`taskLink.status.${key}`) : null;
  return (
    <Link
      to={`/chat/${encodeURIComponent(id)}`}
      data-task-link={id}
      data-status={key ?? "loading"}
      data-flash={flash ? "" : undefined}
      title={word ?? undefined}
      aria-label={word ? t("taskLink.label", { name: label, status: word }) : undefined}
    >
      <span data-task-link-mark>
        {status ? (
          <TaskGlyph status={status} tone="muted" className="size-3.5" />
        ) : (
          <TaskGlyph
            status={{ status: "ended", endReason: "no_response" }}
            tone="muted"
            className="size-3.5"
          />
        )}
      </span>
      <span className="text-foreground">{label}</span>
    </Link>
  );
}
