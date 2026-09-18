import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PlayIcon } from "@radix-ui/react-icons";
import { Link } from "react-router-dom";
import type { RomeSessionRefDto } from "@rome/api-types/trace-segments";
import { CollapsibleTraceRow } from "@/components/agent-trace/CollapsibleTraceRow";

const SYSTEM_PROMPT_COLLAPSED_MAX_HEIGHT = 168;
const SYSTEM_PROMPT_FADE_MASK = "linear-gradient(to bottom, black 70%, transparent 100%)";

export function AgentCallBlock({
  agent,
  sessionId,
  romeSession,
  systemPrompt,
  userPrompt,
}: {
  agent?: string;
  sessionId?: string;
  romeSession?: RomeSessionRefDto;
  systemPrompt?: string;
  userPrompt?: string;
}) {
  const { t } = useTranslation("chat");
  const label = agent ? t("blocks.agentSession", { agent }) : t("blocks.sessionFallback");
  return (
    <CollapsibleTraceRow
      icon={<PlayIcon />}
      label={label}
      // Wider gutters than the tool-group body keep the denser session fields aligned.
      bodyClassName="flex flex-col gap-3 pt-1 pr-3 pb-3 pl-9"
    >
      {sessionId && (
        <Field label={t("blocks.session")}>
          <span className="font-mono text-aux break-all text-foreground">{sessionId}</span>
        </Field>
      )}
      {romeSession && (
        <Field label={t("blocks.romeSession")}>
          <Link
            to={`/${romeSession._type === "webchat" ? "chat" : "sessions"}/${encodeURIComponent(
              romeSession._romeSessionId,
            )}`}
            className="font-mono text-aux break-all text-primary hover:underline"
          >
            {romeSession._romeSessionId}
          </Link>
        </Field>
      )}
      <Field label={t("blocks.systemPrompt")}>
        <CollapsibleLongText text={systemPrompt?.trim() || t("blocks.emptyPrompt")} />
      </Field>
      <Field label={t("blocks.userPrompt")}>
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-aux text-foreground">
          {userPrompt?.trim() || t("blocks.emptyPrompt")}
        </pre>
      </Field>
    </CollapsibleTraceRow>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-aux text-muted-foreground">{label}</div>
      <div className="text-ui text-foreground break-words">{children}</div>
    </div>
  );
}

function CollapsibleLongText({ text }: { text: string }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > SYSTEM_PROMPT_COLLAPSED_MAX_HEIGHT + 1);
    measure();
    let lastWidth = el.getBoundingClientRect().width;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined || width === lastWidth) return;
      lastWidth = width;
      measure();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const collapsed = !expanded && overflowing;

  return (
    <div className="flex flex-col gap-2">
      <pre
        ref={ref}
        className="m-0 overflow-hidden whitespace-pre-wrap break-words font-mono text-aux text-foreground"
        style={
          collapsed
            ? {
                maxHeight: SYSTEM_PROMPT_COLLAPSED_MAX_HEIGHT,
                maskImage: SYSTEM_PROMPT_FADE_MASK,
                WebkitMaskImage: SYSTEM_PROMPT_FADE_MASK,
              }
            : undefined
        }
      >
        {text}
      </pre>
      {overflowing && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="self-start text-aux text-muted-foreground hover:text-foreground"
        >
          {expanded ? t("blocks.showLess") : t("blocks.showMore")}
        </button>
      )}
    </div>
  );
}
