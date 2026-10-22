import { ChevronDownIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import type { Assistant } from "@rome/api-types/assistants";
import { Badge } from "@/components/ui/badge";
import { assistantPath, listAssistants } from "@/lib/assistants-api";

/** How often the list is read again, so a new assistant or a new message
 *  reorders the group without a reload. */
const REFRESH_MS = 30_000;

/** The name for an assistant's kind. A kind this dashboard does not know yet is
 *  shown as Rome Cloud spells it. */
export function useAssistantKindLabel(): (kind: string) => string {
  const { t } = useTranslation("common");
  return (kind) => t(`assistants.kind.${kind}`, { defaultValue: kind });
}

/**
 * The sidebar's Assistants group: one row per assistant, above the dashboard's
 * own chats (docs/domains/chats.md#assistant). Absent while there are none,
 * which includes while Agents is not connected. A failed read keeps the rows
 * it last had rather than emptying the group.
 */
export function AssistantChats({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("common");
  const kindLabel = useAssistantKindLabel();
  const location = useLocation();
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const request = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const current = ++request.current;
      try {
        const next = await listAssistants(controller.signal);
        if (current === request.current) setAssistants(next);
      } catch {
        // Kept: an unreachable Rome Cloud is not the same as no assistants.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
    // Reread on navigation too, so a chat just written in moves to the top.
  }, [location.pathname]);

  if (assistants.length === 0) return null;

  return (
    <section
      aria-labelledby="recent-chats-assistants-heading"
      className="mb-4"
      data-assistants-section
    >
      <button
        type="button"
        id="recent-chats-assistants-heading"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-2 rounded-4 border border-transparent px-2 pb-1 pt-3 text-aux text-subtle-foreground transition outline-none hover:text-foreground outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        {t("assistants.title")}
        {collapsed ? (
          <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
      {collapsed ? null : (
        <div className="space-y-1">
          {assistants.map((assistant) => {
            const path = assistantPath(assistant.agentId);
            const active = location.pathname === path;
            return (
              <Link
                key={assistant.agentId}
                to={path}
                data-assistant-row
                aria-current={active ? "page" : undefined}
                className={`flex h-8 min-h-[var(--control-min-h)] items-center gap-2 rounded-8 border border-transparent px-2 text-ui text-foreground outline-none outline-1 outline-offset-0 outline-transparent transition focus-visible:outline-solid focus-visible:outline-ring/50 ${
                  active
                    ? "bg-surface shadow-1 dark:bg-surface-hover"
                    : "hover:bg-surface-hover dark:hover:bg-surface"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{assistant.name}</span>
                <Badge variant="muted" className="shrink-0">
                  {kindLabel(assistant.kind)}
                </Badge>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
