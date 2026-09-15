import { useTranslation } from "react-i18next";
import type { ApprovalPreviewPayload } from "@/lib/chat-types";

export function ApprovalPreviewBody({ preview }: { preview: ApprovalPreviewPayload }) {
  const { t } = useTranslation("chat");
  if (preview.kind === "sensitive_message") {
    return (
      <div className="space-y-2">
        <div className="text-aux text-muted-foreground">
          {t("approvals.preview.sensitiveTo")}{" "}
          <span className="font-mono text-foreground">{preview.threadId}</span>{" "}
          {t("approvals.preview.sensitiveOn")}{" "}
          <span className="font-mono text-foreground">{preview.channel}</span>
        </div>
        {preview.reason && (
          <div className="text-aux italic text-muted-foreground">{preview.reason}</div>
        )}
        <div className="whitespace-pre-wrap rounded-8 border border-warning-border bg-surface px-3 py-2 text-ui text-foreground">
          {preview.text}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-ui text-foreground">{preview.title}</div>
      <div className="whitespace-pre-wrap text-ui text-foreground">{preview.summary}</div>
      {preview.fields && preview.fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-aux">
          {preview.fields.map((field, idx) => (
            <div key={idx} className="contents">
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="whitespace-pre-wrap text-foreground">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
