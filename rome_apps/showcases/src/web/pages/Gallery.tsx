import { useEffect, useState } from "react";
import type { PresetCategory } from "../../trace/portable.js";
import { fetchPresetCatalog } from "../lib/api.js";
import { PresetCard } from "../components/PresetCard.js";

// Server-driven showcase gallery: categories of CTA cards fetched from the app's
// catalog endpoint. Each card is one app or system action with optional Open /
// Try-it / "see how it was built" actions.
export function Gallery() {
  const [categories, setCategories] = useState<PresetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const cats = await fetchPresetCatalog();
        if (active) setCategories(cats);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Showcases</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Things you can do with Rome — open an app, try a prompt, or see how it was built.
          </p>
        </div>
        <a
          href="#/cases"
          className="shrink-0 rounded-8 border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
        >
          Shared cases →
        </a>
      </header>

      {loading ? <div className="text-sm text-muted-foreground">Loading…</div> : null}

      {error ? (
        <div className="rounded-8 border border-destructive-border bg-destructive-bg px-3 py-2 text-sm text-destructive-fg">
          {error}
        </div>
      ) : null}

      {!loading && !error && categories.length === 0 ? (
        <div className="rounded-12 border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No showcases available yet.
        </div>
      ) : null}

      <div className="space-y-10">
        {categories.map((category) => (
          <section key={category.id}>
            <h2 className="mb-3 text-sm font-semibold text-subtle-foreground">{category.title}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {category.items.map((item) => (
                <PresetCard key={item.id} item={item} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
