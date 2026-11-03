import { fetchAppApi, getBootstrap } from "@rome-os/app-web-sdk";
import type { PresetCatalog, PresetCategory, ShowcaseBundle } from "../../trace/portable.js";
import type { TraceEventDto, TraceSnapshot, TraceSummary } from "../../trace/types.js";

export interface CollectionView {
  id: string;
  title: string;
  description: string | null;
  source: string;
  traceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceSession {
  id: string;
  name: string;
  projectName: string | null;
  projectPath: string | null;
  agentName: string | null;
  createdAt: string;
  traceCount: number;
}

export interface TraceListItem {
  id: string;
  collectionId: string;
  title: string;
  description: string | null;
  capturedAt: string;
  summary: TraceSummary;
  metadata: Record<string, unknown>;
}

export interface TraceDetail extends TraceListItem {
  blocks: TraceEventDto[];
  snapshot: TraceSnapshot;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.message || body.error || message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function appApiUrl(path: string): string {
  const base = getBootstrap().apiBase;
  return path ? `${base}/${path}` : base;
}

export async function listCollections(): Promise<CollectionView[]> {
  const res = await fetchAppApi("collections");
  const data = await jsonOrThrow<{ collections: CollectionView[] }>(res);
  return data.collections;
}

export async function listAllTraces(): Promise<TraceListItem[]> {
  const res = await fetchAppApi("traces");
  const data = await jsonOrThrow<{ traces: TraceListItem[] }>(res);
  return data.traces;
}

export async function listSourceSessions(): Promise<SourceSession[]> {
  const res = await fetchAppApi("sources/sessions");
  const data = await jsonOrThrow<{ sessions: SourceSession[] }>(res);
  return data.sessions;
}

export async function listCollectionTraces(collectionId: string): Promise<TraceListItem[]> {
  const res = await fetchAppApi(`collections/${encodeURIComponent(collectionId)}/traces`);
  const data = await jsonOrThrow<{ traces: TraceListItem[] }>(res);
  return data.traces;
}

export async function getTrace(traceId: string): Promise<TraceDetail> {
  const res = await fetchAppApi(`traces/${encodeURIComponent(traceId)}`);
  const data = await jsonOrThrow<{ trace: TraceDetail }>(res);
  return data.trace;
}

export interface SessionDetail {
  collection: {
    id: string;
    title: string;
    description: string | null;
    source: string;
  };
  turns: TraceDetail[];
}

export async function getSession(collectionId: string): Promise<SessionDetail> {
  const res = await fetchAppApi(`collections/${encodeURIComponent(collectionId)}/session`);
  return jsonOrThrow<SessionDetail>(res);
}

export async function importWebchatSession(sessionId: string, title?: string): Promise<void> {
  const res = await fetchAppApi("imports/webchat-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, title }),
  });
  await jsonOrThrow(res);
}

// Accepts either a ShowcaseBundle or a bare trace-blocks array (the /chat
// "Download raw trace JSON" format); the backend coerces/validates it.
export async function importBundle(bundle: unknown): Promise<void> {
  const res = await fetchAppApi("imports/bundle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
  await jsonOrThrow(res);
}

export async function deleteCollection(collectionId: string): Promise<void> {
  const res = await fetchAppApi(`collections/${encodeURIComponent(collectionId)}`, {
    method: "DELETE",
  });
  await jsonOrThrow(res);
}

// Fetch the showcase catalog (v2: categories of CTA cards) from the app's own
// API. The catalog is server-owned (currently the app-local mock); a future step
// can source it from Rome Cloud via the core relay.
export async function fetchPresetCatalog(): Promise<PresetCategory[]> {
  const res = await fetchAppApi("presets");
  const body = await jsonOrThrow<Partial<PresetCatalog>>(res);
  return Array.isArray(body.categories) ? body.categories : [];
}

export function exportBundleUrl(collectionIds?: string | string[]): string {
  const ids = (Array.isArray(collectionIds) ? collectionIds : collectionIds ? [collectionIds] : [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (ids.length === 0) return "exports/bundle";
  const suffix = ids.map((id) => `collectionId=${encodeURIComponent(id)}`).join("&");
  return `exports/bundle?${suffix}`;
}

// Fetch a collection's export as a parsed bundle (the same endpoint backs the
// download link; here we parse it so we can hand it to the publish relay).
export async function fetchExportBundle(collectionIds: string | string[]): Promise<ShowcaseBundle> {
  const res = await fetchAppApi(exportBundleUrl(collectionIds));
  return jsonOrThrow<ShowcaseBundle>(res);
}

// ─── Remote cases (Rome Cloud preset sharing) ────────────────────────────────
//
// Published "cases" sync into any instance through the core relay at
// `/api/showcase-presets/*`. The app frontend talks only to that relay (a
// root-relative, same-origin dashboard route) and to its own app API — it never
// reaches Rome Cloud directly. The relay holds the instance credential.

const RELAY_BASE = "/api/showcase-presets";

export interface RemoteCatalogPreset {
  id: string;
  title: string;
  description: string;
  publisher: string | null;
  traceCount: number;
  contentHash: string;
  updatedAt: string;
  bundleUrl: string;
}

export type RemoteCatalogResult =
  | { available: true; presets: RemoteCatalogPreset[] }
  | { available: false; reason?: string };

export async function fetchRemoteCatalog(): Promise<RemoteCatalogResult> {
  let res: Response;
  try {
    res = await fetch(`${RELAY_BASE}/catalog`, { headers: { accept: "application/json" } });
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : "Network error" };
  }
  if (!res.ok) return { available: false, reason: `Request failed (${res.status})` };
  const body = (await res.json()) as
    | { available?: false; reason?: string; error?: string }
    | { presets?: RemoteCatalogPreset[] };
  if ("available" in body && body.available === false)
    return { available: false, reason: body.reason };
  if ("error" in body && body.error) return { available: false, reason: body.error };
  return { available: true, presets: (body as { presets?: RemoteCatalogPreset[] }).presets ?? [] };
}

export async function fetchRemoteBundle(presetId: string): Promise<ShowcaseBundle> {
  const res = await fetch(`${RELAY_BASE}/${encodeURIComponent(presetId)}/bundle`, {
    headers: { accept: "application/json" },
  });
  return jsonOrThrow<ShowcaseBundle>(res);
}

export async function canPublishCases(): Promise<boolean> {
  try {
    const res = await fetch(`${RELAY_BASE}/can-publish`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { canPublish?: boolean };
    return body.canPublish === true;
  } catch {
    return false;
  }
}

export interface PublishCasesResult {
  id: string;
  contentHash: string;
  title: string;
  deduplicated: boolean;
}

export async function publishCases(
  bundle: ShowcaseBundle,
  options: { title?: string; description?: string } = {},
): Promise<PublishCasesResult> {
  const res = await fetch(`${RELAY_BASE}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ bundle, title: options.title, description: options.description }),
  });
  const data = await jsonOrThrow<{ preset: PublishCasesResult }>(res);
  return data.preset;
}

// Revoke a preset on Rome Cloud (soft delete). Other instances drop it on their
// next sync. Only the original publisher (or an operator) is allowed upstream.
export async function unpublishCases(presetId: string): Promise<void> {
  const res = await fetch(`${RELAY_BASE}/${encodeURIComponent(presetId)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  await jsonOrThrow(res);
}
