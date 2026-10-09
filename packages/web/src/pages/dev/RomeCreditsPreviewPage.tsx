import { AiToolsCard } from "@/components/chat/entries/AiToolsCard";
import { ErrorEventView } from "@/components/chat/entries/ErrorEventView";

// The chat surfaces Rome credits reach: the welcome conversation's connect step
// and the used-up error, in both presentations. The AI Tools row lives on
// /settings/ai-tools.
export default function RomeCreditsPreviewPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <section>
        <p className="mb-2 text-aux text-muted-foreground">Welcome: connect step</p>
        <AiToolsCard toolUseId="preview" onSubmit={() => {}} />
      </section>
      <section>
        <p className="mb-2 text-aux text-muted-foreground">Welcome: resolved with credits</p>
        <AiToolsCard
          toolUseId="preview-resolved"
          result={{ connected: true, credits: true }}
          onSubmit={() => {}}
        />
      </section>
      <section>
        <p className="mb-2 text-aux text-muted-foreground">Chat: credits used up</p>
        <ErrorEventView error="Rome credits are used up." code="credits_used_up" />
      </section>
      <section>
        <p className="mb-2 text-aux text-muted-foreground">Chat: credits used up (status)</p>
        <ErrorEventView
          error="Rome credits are used up."
          code="credits_used_up"
          presentation="status"
        />
      </section>
    </div>
  );
}
