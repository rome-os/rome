import "./styles.css";
import { useCallback, useEffect, useState } from "react";
import { fetchAppApi, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { Button } from "@rome-os/ui/button";
import { Page, PageDescription, PageHeader, PageHeading, PageTitle } from "@rome-os/ui/page";

type DocumentName = "roster" | "goals";

interface TeamDocument {
  name: DocumentName;
  body: string;
  updatedAt: string | null;
}

const LABELS: Record<DocumentName, { title: string; hint: string; placeholder: string }> = {
  roster: {
    title: "Roster",
    hint: "Every team member, their role, and what they are working on now. The chief of staff names nobody who is not here.",
    placeholder: "## Ada\nRole: engineer\nWorking on: the planning loop\n",
  },
  goals: {
    title: "Goals",
    hint: "Each goal with its owner and date. Mark a goal the team has dropped so the chief of staff leaves it out.",
    placeholder: "## Ship the planning loop\nOwner: Ada\nDate: 2026-12-01\nStatus: active\n",
  },
};

function DocumentEditor({ document }: { document: TeamDocument }) {
  const label = LABELS[document.name];
  const [body, setBody] = useState(document.body);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(document.updatedAt);
  const [error, setError] = useState<string | null>(null);
  const dirty = body !== document.body && !saving;

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetchAppApi(`documents/${document.name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      const data = (await res.json()) as { document: TeamDocument };
      document.body = data.document.body;
      setSavedAt(data.document.updatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }, [body, document]);

  return (
    <section className="flex flex-col gap-2 rounded-12 border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-section font-medium">{label.title}</h2>
        {savedAt ? (
          <span className="text-aux text-[var(--muted-foreground)]">
            saved {new Date(savedAt).toLocaleString()}
          </span>
        ) : null}
      </div>
      <p className="text-ui text-[var(--muted-foreground)]">{label.hint}</p>
      <textarea
        className="min-h-56 w-full resize-y rounded-8 border border-[var(--border)] bg-[var(--background)] p-3 font-mono text-ui"
        value={body}
        placeholder={label.placeholder}
        spellCheck={false}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={!dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {error ? <span className="text-ui text-[var(--destructive)]">{error}</span> : null}
      </div>
    </section>
  );
}

export default function App(_props: { bootstrap: RomeAppBootstrap }) {
  const [documents, setDocuments] = useState<TeamDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchAppApi("state")
      .then((res) => {
        if (!res.ok) throw new Error(`load failed (${res.status})`);
        return res.json() as Promise<{ documents: TeamDocument[] }>;
      })
      .then((data) => {
        if (live) setDocuments(data.documents);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : "load failed");
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <Page className="mx-auto max-w-3xl p-6">
      <PageHeader>
        <PageHeading>
          <PageTitle>Chief Of Staff</PageTitle>
        </PageHeading>
        <PageDescription>
          The roster and the goals document the chief of staff reads. It knows the team and its
          goals only from what you write here.
        </PageDescription>
      </PageHeader>
      {error ? (
        <p className="text-ui text-[var(--destructive)]">{error}</p>
      ) : documents ? (
        <div className="flex flex-col gap-4">
          {documents.map((document) => (
            <DocumentEditor key={document.name} document={document} />
          ))}
        </div>
      ) : (
        <p className="text-ui text-[var(--muted-foreground)]">Loading…</p>
      )}
    </Page>
  );
}
