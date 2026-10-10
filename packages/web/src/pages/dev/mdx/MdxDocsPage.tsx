import { Suspense } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { MDX_DOCS } from "./docs";
import { mdxComponents } from "./mdx-components";

// /dev/mdx — the MDX design-doc host. The doc list is a sidebar and the
// selection rides in `?doc=`, so a doc is a shareable URL without a nested
// route: one DEV_ROUTES entry covers the whole surface.

export default function MdxDocsPage() {
  const [params, setParams] = useSearchParams();
  const slug = params.get("doc") ?? MDX_DOCS[0]?.slug;
  const active = MDX_DOCS.find((doc) => doc.slug === slug);

  return (
    <div className="flex min-h-screen bg-background">
      <nav className="w-64 shrink-0 border-r border-border bg-surface">
        <div className="border-b border-border px-4 py-4">
          <Link to="/dev" className="text-badge text-muted-foreground hover:text-foreground">
            ← Dev pages
          </Link>
          <h1 className="mt-2 text-section text-foreground">Design docs</h1>
        </div>
        <ul className="p-2">
          {MDX_DOCS.map((doc) => (
            <li key={doc.slug}>
              <button
                type="button"
                onClick={() => setParams({ doc: doc.slug })}
                className={cn(
                  "w-full rounded-8 px-3 py-2 text-left transition-colors",
                  doc.slug === slug ? "bg-surface-muted" : "hover:bg-surface-hover",
                )}
              >
                <span className="block text-ui text-foreground">{doc.title}</span>
                <span className="mt-1 block text-aux text-muted-foreground">{doc.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-3xl px-8 py-10">
          {active ? (
            <Suspense fallback={<p className="text-ui text-muted-foreground">Loading…</p>}>
              <active.Doc components={mdxComponents} />
            </Suspense>
          ) : (
            <p className="text-ui text-muted-foreground">No doc named “{slug}”.</p>
          )}
        </div>
      </main>
    </div>
  );
}
