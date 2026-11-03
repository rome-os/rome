import "./styles.css";
import { useCallback, useState } from "react";
import { startChat, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { Field, FieldLabel, FormError } from "@rome-os/ui/field";
import {
  Measure,
  Page,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@rome-os/ui/page";
import { Textarea } from "@rome-os/ui/textarea";

const EXAMPLE_PROMPTS = [
  "Every morning, summarize my unread emails and post the digest to my chat.",
  "When I save a link to my reading list, fetch the article and add a short summary.",
];

// The app is a front door: describing an automation opens a fresh guardian chat
// with that message under the `design-workflow` skill, which shapes it into a
// short spec, gets the guardian's approval, and builds the workflow — all in that
// one conversation. There is no panel to mirror, so the page is just the launcher.
export default function App({ bootstrap: _bootstrap }: { bootstrap: RomeAppBootstrap }) {
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    const message = draft.trim();
    if (!message || starting) return;
    setStarting(true);
    setError(null);
    try {
      await startChat({ message, skillName: "design-workflow" });
      // startChat navigates to the new chat on success; no further work here.
    } catch {
      setStarting(false);
      setError("Couldn't start a chat just now — try again.");
    }
  }, [draft, starting]);

  return (
    <Page className="min-h-full">
      <PageHeader>
        <PageHeading>
          <PageTitle>Build a workflow</PageTitle>
          <PageDescription>
            Describe an automation in plain language. Your guardian shapes it into a short spec you
            approve, then builds it into a runnable workflow — all in one conversation.
          </PageDescription>
        </PageHeading>
      </PageHeader>
      <Measure className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="ws-workflow-description" className="sr-only">
            Workflow description
          </FieldLabel>
          <Textarea
            id="ws-workflow-description"
            rows={3}
            placeholder="e.g. Every morning, summarize my unread emails and post the digest to my chat."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void start();
              }
            }}
            disabled={starting}
          />
        </Field>
        <div>
          <Button onClick={() => void start()} disabled={!draft.trim() || starting}>
            {starting ? "Starting…" : "Design this workflow"}
          </Button>
        </div>
        {error ? <FormError>{error}</FormError> : null}
        <div className="flex flex-col items-start gap-2 pt-2">
          <span className="text-aux text-muted-foreground">Try one of these</span>
          {EXAMPLE_PROMPTS.map((p) => (
            <Button
              key={p}
              type="button"
              variant="secondary"
              align="start"
              onClick={() => setDraft(p)}
              disabled={starting}
              className="h-auto w-full text-left whitespace-normal py-2 font-normal leading-relaxed border border-border hover:border-muted-foreground"
            >
              {p}
            </Button>
          ))}
        </div>
      </Measure>
    </Page>
  );
}
