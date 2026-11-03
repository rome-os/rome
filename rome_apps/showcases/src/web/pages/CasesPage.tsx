import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Cloud,
  CloudOff,
  FileJson,
  FileUp,
  FolderOpen,
  Play,
  RefreshCw,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import {
  canPublishCases,
  deleteCollection,
  fetchExportBundle,
  fetchRemoteCatalog,
  importBundle,
  importWebchatSession,
  listCollections,
  listSourceSessions,
  publishCases,
  unpublishCases,
  type CollectionView,
  type RemoteCatalogPreset,
  type SourceSession,
} from "../lib/api.js";

// Local collection groups (kept in the app DB). Shared/cloud cases are NOT
// here — they are streamed live from the catalog, never copied locally.
const LOCAL_GROUPS: Array<{ key: string; title: string; sources: string[] }> = [
  { key: "imports", title: "My imports", sources: ["local-import", "bundle"] },
];

// Sources a guardian may publish: their own imports, never bundled samples.
const PUBLISHABLE_SOURCES = new Set(["local-import", "bundle"]);

const cardClass =
  "group flex min-h-[148px] flex-col gap-4 rounded-12 border border-border bg-surface p-4 shadow-1 transition-colors hover:border-primary/60";
const secondaryButtonClass =
  "inline-flex h-9 items-center gap-1.5 rounded-8 border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50";
const smallPrimaryButtonClass =
  "inline-flex h-8 items-center gap-1.5 rounded-8 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90";
const smallSecondaryButtonClass =
  "inline-flex h-8 items-center gap-1.5 rounded-8 border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50";

export function CasesPage({ navigate }: { navigate: (hash: string) => void }) {
  const [localCollections, setLocalCollections] = useState<CollectionView[]>([]);
  const [catalog, setCatalog] = useState<RemoteCatalogPreset[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceSession[]>([]);
  const [canPublish, setCanPublish] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sourceSessionId, setSourceSessionId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadLocal = useCallback(async () => {
    const [cols, srcs] = await Promise.all([
      listCollections(),
      listSourceSessions().catch(() => [] as SourceSession[]),
    ]);
    setLocalCollections(cols);
    setSources(srcs);
    if (!sourceSessionId && srcs[0]) setSourceSessionId(srcs[0].id);
  }, [sourceSessionId]);

  // Shared cases are read straight from Rome Cloud every time — no local copy,
  // so the list is always current and a publisher's delete shows up at once.
  const loadCatalog = useCallback(async () => {
    const res = await fetchRemoteCatalog();
    if (res.available) {
      setCatalog(res.presets);
      setCatalogError(null);
    } else {
      setCatalog([]);
      setCatalogError(res.reason ?? "Rome Cloud is unavailable.");
    }
  }, []);

  useEffect(() => {
    void loadLocal();
    void loadCatalog();
    void canPublishCases().then(setCanPublish);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function withBusy(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setStatus(label);
    try {
      await fn();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleImportSession() {
    if (!sourceSessionId) return;
    await withBusy("Importing local chat history…", async () => {
      await importWebchatSession(sourceSessionId);
      await loadLocal();
      setImportOpen(false);
      setStatus("Imported cases from local chat history.");
    });
  }

  async function handleBundleFile(file: File | null) {
    if (!file) return;
    await withBusy("Importing bundle…", async () => {
      // Either a Showcases export bundle or a bare trace-blocks array (the
      // /chat "Download raw trace JSON" file); the backend coerces both.
      const bundle = JSON.parse(await file.text()) as unknown;
      await importBundle(bundle);
      await loadLocal();
      setImportOpen(false);
      setStatus("Imported cases from bundle.");
    });
  }

  async function handlePublish(collection: CollectionView) {
    await withBusy(`Publishing “${collection.title}” to Rome Cloud…`, async () => {
      const bundle = await fetchExportBundle(collection.id);
      const result = await publishCases(bundle, { title: collection.title });
      await loadCatalog();
      setStatus(
        result.deduplicated
          ? `“${collection.title}” is already published — no changes.`
          : `Published “${collection.title}” to Rome Cloud.`,
      );
    });
  }

  async function handleDelete(collection: CollectionView) {
    await withBusy(`Removing “${collection.title}”…`, async () => {
      await deleteCollection(collection.id);
      await loadLocal();
      setStatus(`Removed “${collection.title}”.`);
    });
  }

  // Revoke a shared case on Rome Cloud. Other instances stop seeing it on their
  // next load (the catalog only lists live presets); nothing local to clean up.
  async function handleUnpublish(preset: RemoteCatalogPreset) {
    await withBusy(`Removing “${preset.title}” from Rome Cloud…`, async () => {
      await unpublishCases(preset.id);
      await loadCatalog();
      setStatus(`Removed “${preset.title}” from Rome Cloud.`);
    });
  }

  const localGroups = useMemo(() => {
    return LOCAL_GROUPS.map((group) => ({
      ...group,
      items: localCollections.filter((c) => group.sources.includes(c.source)),
    }));
  }, [localCollections]);

  const localImportCount = localCollections.filter((collection) =>
    PUBLISHABLE_SOURCES.has(collection.source),
  ).length;
  const totalSharedTraces = catalog.reduce((sum, preset) => sum + preset.traceCount, 0);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <header className="mb-6 rounded-12 border border-border bg-surface px-4 py-4 shadow-1 sm:px-5">
        <button
          type="button"
          onClick={() => navigate("#/")}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} /> Showcases
        </button>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-foreground">Shared cases</h1>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-8 border border-border bg-background px-2.5 py-1">
                <Cloud size={13} /> {catalog.length} shared pack{catalog.length === 1 ? "" : "s"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-8 border border-border bg-background px-2.5 py-1">
                <Play size={13} /> {totalSharedTraces} replayable trace
                {totalSharedTraces === 1 ? "" : "s"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-8 border border-border bg-background px-2.5 py-1">
                <FolderOpen size={13} /> {localImportCount} local import
                {localImportCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void withBusy("Refreshing…", async () => {
                  await Promise.all([loadCatalog(), loadLocal()]);
                  setStatus(null);
                })
              }
              className={secondaryButtonClass}
            >
              <RefreshCw size={15} /> Refresh
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setImportOpen(true)}
              className={secondaryButtonClass}
            >
              <FileUp size={15} /> Import
            </button>
          </div>
        </div>
      </header>

      {status ? (
        <div className="mb-5 rounded-12 border border-border bg-surface px-4 py-3 text-sm text-muted-foreground shadow-1">
          {status}
        </div>
      ) : null}

      <div className="space-y-10">
        {/* Shared cases — streamed live from Rome Cloud. */}
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">Shared cases</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Cloud case packs ready to replay.
              </p>
            </div>
          </div>
          {catalogError ? (
            <div className="rounded-12 border border-border bg-surface px-4 py-3 text-sm text-muted-foreground shadow-1">
              Couldn’t reach Rome Cloud: {catalogError}
            </div>
          ) : catalog.length === 0 ? (
            <div className="rounded-12 border border-dashed border-border bg-surface p-10 text-center text-sm text-muted-foreground">
              No shared cases yet. Published case packs from Rome Cloud will appear here.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {catalog.map((preset) => (
                <div key={preset.id} className={cardClass}>
                  <div className="flex items-start gap-3">
                    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-8 bg-surface-muted text-primary">
                      <Cloud size={18} />
                    </span>
                    <div className="min-w-0">
                      <div className="line-clamp-2 text-sm font-semibold text-foreground">
                        {preset.title}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                        <span>
                          {preset.traceCount} trace{preset.traceCount === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
                    <button
                      type="button"
                      onClick={() => navigate(`#/shared/${encodeURIComponent(preset.id)}`)}
                      className={smallPrimaryButtonClass}
                    >
                      <Play size={13} /> Replay
                    </button>
                    {canPublish ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleUnpublish(preset)}
                        className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-8 border border-border bg-background px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                      >
                        <CloudOff size={13} /> Unpublish
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Local imports saved in this app DB. */}
        {localGroups.map((group) => (
          <section key={group.key}>
            <div className="mb-3">
              <h2 className="text-base font-semibold text-foreground">{group.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Imported packs saved on this Rome instance.
              </p>
            </div>
            {group.items.length === 0 ? (
              <div className="rounded-12 border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                You haven’t imported any cases yet — use “Import” above to add a local chat session
                or bundle.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {group.items.map((collection) => (
                  <div key={collection.id} className={cardClass}>
                    <div className="flex items-start gap-3">
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-8 bg-surface-muted text-foreground">
                        <FileJson size={18} />
                      </span>
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-sm font-semibold text-foreground">
                          {collection.title}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {collection.traceCount} trace{collection.traceCount === 1 ? "" : "s"}
                        </div>
                      </div>
                    </div>
                    <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
                      <button
                        type="button"
                        onClick={() => navigate(`#/session/${encodeURIComponent(collection.id)}`)}
                        className={smallPrimaryButtonClass}
                      >
                        <Play size={13} /> Replay
                      </button>
                      {canPublish && PUBLISHABLE_SOURCES.has(collection.source) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handlePublish(collection)}
                          className={smallSecondaryButtonClass}
                        >
                          <Share2 size={13} /> Publish
                        </button>
                      ) : null}
                      {PUBLISHABLE_SOURCES.has(collection.source) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDelete(collection)}
                          className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-8 border border-border bg-background text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
                          aria-label={`Remove ${collection.title}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      {importOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setImportOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-12 border border-border bg-background p-5 shadow-10">
            <div className="flex items-start gap-3 border-b border-border pb-4">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-8 bg-surface-muted text-primary">
                <FileUp size={18} />
              </span>
              <div>
                <h3 className="text-base font-semibold text-foreground">Import cases</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Choose a local session or a bundle file.
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label className="text-xs font-medium text-muted-foreground">
                From a local chat session
              </label>
              <div className="mt-1.5 flex gap-2">
                <select
                  value={sourceSessionId}
                  onChange={(e) => setSourceSessionId(e.target.value)}
                  disabled={sources.length === 0}
                  className="min-w-0 flex-1 rounded-8 border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {sources.length === 0 ? (
                    <option value="">No local sessions found</option>
                  ) : (
                    sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  disabled={busy || !sourceSessionId}
                  onClick={() => void handleImportSession()}
                  className="inline-flex items-center gap-1 rounded-8 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  Import
                </button>
              </div>
            </div>

            <div className="mt-5">
              <label className="text-xs font-medium text-muted-foreground">
                From a bundle file
              </label>
              <p className="mt-0.5 text-aux text-subtle-foreground">
                A Showcases export, or a turn’s “Download raw trace JSON” file from a chat.
              </p>
              <div className="mt-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => void handleBundleFile(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                  className={secondaryButtonClass}
                >
                  <Upload size={15} /> Choose bundle…
                </button>
              </div>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                className="rounded-8 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
