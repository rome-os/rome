import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import {
  type CollectionSource,
  ShowcasesRepository,
  type TraceDetail,
} from "../db/repositories/showcases.js";
import { defaultSampleBundle } from "../samples/default-bundle.js";
import { MOCK_PRESET_CATALOG } from "../samples/mock-catalog.js";
import { buildTraceSnapshot } from "../trace/build-snapshot.js";
import {
  PRESET_ENDPOINT_CONTRACT,
  type PresetCatalog,
  type ShowcaseBundle,
  SHOWCASE_BUNDLE_SCHEMA,
  SHOWCASE_BUNDLE_VERSION,
  isShowcaseBundle,
} from "../trace/portable.js";
import type { ReplyBlock, ReplyInteractionBlock, TraceBlockDto } from "../trace/types.js";

interface SourceSessionRow {
  id: string;
  name: string;
  project_name: string | null;
  project_path: string | null;
  agent_name: string | null;
  created_at: number | string | Date;
  trace_count: number;
}

interface SourceTraceRow {
  session_id: string;
  session_name: string;
  project_name: string | null;
  project_path: string | null;
  agent_name: string | null;
  session_created_at: number | string | Date;
  message_id: string;
  turn_id: string | null;
  content: string;
  message_created_at: number | string | Date;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function readJsonBody(request: RomeAppApiRequest): unknown {
  if (!request.body || request.body.byteLength === 0) return null;
  const text = new TextDecoder().decode(request.body);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toDate(value: number | string | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") {
    return new Date(value > 10_000_000_000 ? value : value * 1000);
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return toDate(numeric);
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function parseTraceBlocks(content: string): TraceBlockDto[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? (parsed as TraceBlockDto[]) : [];
  } catch {
    return [{ type: "text", content, agent: "main" }];
  }
}

function extractUserText(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      const text = parsed
        .filter(
          (part): part is { type: string; content?: string; text?: string } =>
            !!part && typeof part === "object",
        )
        .map((part) => (typeof part.content === "string" ? part.content : (part.text ?? "")))
        .join("")
        .trim();
      return text || null;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as { content?: unknown; text?: unknown };
      if (typeof record.content === "string") return record.content.trim() || null;
      if (typeof record.text === "string") return record.text.trim() || null;
    }
  } catch {
    return content.trim() || null;
  }
  return content.trim() || null;
}

function sourceTraceTitle(row: SourceTraceRow, index: number): string {
  const sessionName = row.session_name?.trim() || "Imported trace";
  return index === 0 ? sessionName : `${sessionName} · trace ${index + 1}`;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function collectionSource(source: unknown, fallback: CollectionSource): CollectionSource {
  return source === "sample" || source === "remote-preset" || source === "local-import"
    ? source
    : fallback;
}

function bundleDownloadResponse(bundle: ShowcaseBundle, filename: string): Response {
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function stripThreadContext(text: string): string {
  return text.replace(/<thread_context>[\s\S]*?<\/thread_context>/gi, "").trim();
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// The guardian's prompt for a one-turn trace. Prefer the clean `turn_start`
// prompt; fall back to the `session_init` prompt with its injected
// `<thread_context>` envelope stripped.
function traceBlocksUserPrompt(blocks: TraceBlockDto[]): string | undefined {
  const find = (type: string): string | undefined => {
    for (const raw of blocks as Array<{ type?: string; userPrompt?: unknown }>) {
      if (raw?.type === type && typeof raw.userPrompt === "string" && raw.userPrompt.trim()) {
        return raw.userPrompt;
      }
    }
    return undefined;
  };
  const fromTurnStart = find("turn_start");
  if (fromTurnStart) return fromTurnStart.trim();
  const fromSessionInit = find("session_init");
  return fromSessionInit ? stripThreadContext(fromSessionInit) : undefined;
}

// Wrap a bare trace-blocks array (the shape /chat's "Download raw trace JSON"
// button produces for one turn) into a single-trace bundle, so a downloaded
// chat trace imports directly.
function bundleFromTraceBlocks(blocks: TraceBlockDto[]): ShowcaseBundle {
  const prompt = traceBlocksUserPrompt(blocks);
  const title = prompt ? truncate(prompt, 80) : "Imported trace";
  const now = new Date().toISOString();
  return {
    schema: SHOWCASE_BUNDLE_SCHEMA,
    version: SHOWCASE_BUNDLE_VERSION,
    exportedAt: now,
    collections: [
      {
        id: randomUUID(),
        title,
        description: null,
        source: "bundle",
        traces: [
          {
            id: randomUUID(),
            title,
            description: null,
            capturedAt: now,
            blocks,
            metadata: prompt ? { userPrompt: prompt } : {},
          },
        ],
      },
    ],
  };
}

// Accept either a full ShowcaseBundle or a bare trace-blocks array (the chat
// trace download), coercing the latter into a one-trace bundle. Returns null
// for anything else.
function coerceImportBundle(value: unknown): ShowcaseBundle | null {
  if (isShowcaseBundle(value)) return value;
  // A non-empty bare trace-blocks array; an empty array carries no turn, so
  // reject it rather than importing a blank trace.
  if (Array.isArray(value) && value.length > 0)
    return bundleFromTraceBlocks(value as TraceBlockDto[]);
  return null;
}

class ShowcasesApiHandler implements RomeAppApiHandler {
  private readonly repo: ShowcasesRepository;

  constructor(private readonly ctx: RomeAppContext) {
    this.repo = new ShowcasesRepository(ctx.db);
  }

  async handle(request: RomeAppApiRequest): Promise<Response> {
    await this.ensureSeeded();

    const route = request.path.join("/");

    if (request.method === "GET" && request.path.length === 0) {
      return json({
        appId: this.ctx.app.id,
        version: this.ctx.app.version,
        status: "ok",
        bundleSchema: SHOWCASE_BUNDLE_SCHEMA,
        bundleVersion: SHOWCASE_BUNDLE_VERSION,
      });
    }

    if (request.method === "GET" && route === "preset-contract") {
      return json(PRESET_ENDPOINT_CONTRACT);
    }

    if (request.method === "GET" && route === "presets") {
      return json(this.localPresetCatalog());
    }

    if (request.method === "GET" && route === "presets/default/bundle") {
      return bundleDownloadResponse(defaultSampleBundle, "showcases-default-samples.bundle.json");
    }

    if (request.method === "GET" && route === "sources/sessions") {
      return json({ sessions: this.listSourceSessions() });
    }

    if (request.method === "GET" && route === "collections") {
      return json({ collections: this.repo.listCollections() });
    }

    if (request.method === "GET" && route === "traces") {
      return json({ traces: this.repo.listTraces() });
    }

    if (
      request.method === "GET" &&
      request.path[0] === "collections" &&
      request.path[2] === "traces"
    ) {
      const collectionId = request.path[1];
      const collection = this.repo.getCollection(collectionId);
      if (!collection) return json({ error: "collection_not_found" }, { status: 404 });
      return json({ traces: this.repo.listTraces(collectionId) });
    }

    if (
      request.method === "GET" &&
      request.path[0] === "collections" &&
      request.path[2] === "session"
    ) {
      const collectionId = request.path[1];
      const collection = this.repo.getCollection(collectionId);
      if (!collection) return json({ error: "collection_not_found" }, { status: 404 });
      return json({
        collection: {
          id: collection.id,
          title: collection.title,
          description: collection.description,
          source: collection.source,
        },
        turns: this.repo.listCollectionTraceDetails(collectionId),
      });
    }

    if (
      request.method === "DELETE" &&
      request.path[0] === "collections" &&
      request.path.length === 2
    ) {
      this.repo.deleteCollection(request.path[1]);
      return json({ ok: true });
    }

    if (request.method === "GET" && request.path[0] === "traces" && request.path.length === 2) {
      const trace = this.repo.getTrace(request.path[1]);
      if (!trace) return json({ error: "trace_not_found" }, { status: 404 });
      return json({ trace });
    }

    if (
      request.method === "GET" &&
      request.path[0] === "traces" &&
      request.path[2] === "raw.json"
    ) {
      const trace = this.repo.getTrace(request.path[1]);
      if (!trace) return json({ error: "trace_not_found" }, { status: 404 });
      return new Response(JSON.stringify(trace.blocks, null, 2), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="trace-${trace.id}.json"`,
        },
      });
    }

    if (request.method === "POST" && route === "imports/webchat-session") {
      const body = readJsonBody(request);
      if (body === undefined) return json({ error: "invalid_json" }, { status: 400 });
      const sessionId = (body as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        return json({ error: "session_id_required" }, { status: 400 });
      }
      const imported = this.importWebchatSession(sessionId.trim(), {
        title:
          typeof (body as { title?: unknown }).title === "string"
            ? String((body as { title?: unknown }).title)
            : undefined,
      });
      return json(imported, { status: imported.traceCount > 0 ? 200 : 404 });
    }

    if (request.method === "POST" && route === "imports/bundle") {
      const body = readJsonBody(request);
      if (body === undefined) return json({ error: "invalid_json" }, { status: 400 });
      // Accept the app's own export bundle, a `{ bundle }` envelope, or a bare
      // trace-blocks array (the /chat "Download raw trace JSON" format). Unwrap
      // the envelope only for a plain object so an empty/`null` body can't
      // null-deref `.bundle` (it falls through to invalid_bundle below).
      const raw =
        body && typeof body === "object" && !Array.isArray(body) && "bundle" in body
          ? (body as { bundle?: unknown }).bundle
          : body;
      const bundle = coerceImportBundle(raw);
      if (!bundle) {
        return json({ error: "invalid_bundle" }, { status: 400 });
      }
      return json(this.importBundle(bundle, "bundle"));
    }

    if (request.method === "GET" && route === "exports/bundle") {
      const collectionIds = request.query
        .getAll("collectionId")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      const bundle = this.exportBundle(collectionIds);
      return bundleDownloadResponse(bundle, "showcases.bundle.json");
    }

    return json(
      {
        error: "not_found",
        appId: this.ctx.app.id,
        message: `Unknown Showcases API route: /${route}`,
      },
      { status: 404 },
    );
  }

  private ensureSeeded(): void {
    const sampleCollectionId = defaultSampleBundle.collections[0]?.id;
    if (!sampleCollectionId || this.repo.getCollection(sampleCollectionId)) return;
    this.importBundle(defaultSampleBundle, "sample");
  }

  // The showcase catalog (v2): server-driven categories of CTA cards. Served by
  // GET /presets and consumed by the gallery. Mock data for this first step.
  private localPresetCatalog(): PresetCatalog {
    return MOCK_PRESET_CATALOG;
  }

  private listSourceSessions(): Array<{
    id: string;
    name: string;
    projectName: string | null;
    projectPath: string | null;
    agentName: string | null;
    createdAt: string;
    traceCount: number;
  }> {
    const rows = this.ctx.db.connection.all(sql`
      SELECT
        ws.id,
        ws.name,
        ws.project_name,
        ws.project_path,
        ws.agent_name,
        ws.created_at,
        cast(count(wm.id) as integer) AS trace_count
      FROM rome_sessions ws
      JOIN rome_agent_messages wm ON wm.session_id = ws.id AND wm.role = 'trace'
      WHERE ws.type IN ('webchat', 'webchat_handoff')
      GROUP BY ws.id, ws.name, ws.project_name, ws.project_path, ws.agent_name, ws.created_at
      ORDER BY max(wm.created_at) DESC
      LIMIT 100
    `) as SourceSessionRow[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      projectName: row.project_name,
      projectPath: row.project_path,
      agentName: row.agent_name,
      createdAt: toDate(row.created_at).toISOString(),
      traceCount: Number(row.trace_count) || 0,
    }));
  }

  private userPromptsByTurn(sessionId: string): Map<string, string> {
    const map = new Map<string, string>();
    const rows = this.ctx.db.connection.all(sql`
      SELECT wm.turn_id AS turn_id, wm.content AS content
      FROM rome_agent_messages wm
      WHERE wm.session_id = ${sessionId}
        AND wm.role = 'user'
      ORDER BY wm.created_at ASC
    `) as Array<{ turn_id: string | null; content: string }>;
    for (const row of rows) {
      if (!row.turn_id || map.has(row.turn_id)) continue;
      const text = extractUserText(row.content);
      if (text) map.set(row.turn_id, text);
    }
    return map;
  }

  // Reassemble each trace message's full block array from the append-only
  // `rome_agent_trace_blocks` table, keyed by the trace message id.
  //
  // Core no longer stores the trace inline: a role='trace' rome_agent_messages row
  // is a constant `'[]'` stub, and every block (tool_use, thinking, text, …)
  // lives as its own `rome_agent_trace_blocks` row ordered by seq. Reading
  // `wm.content` alone yields the empty stub, which is why an imported replay
  // showed no steps and no final answer. We mirror the repository's
  // `mergeTraceContent`: concatenate the per-message block JSON back into a
  // single array (and fall back to the stub for legacy traces with no rows).
  private traceContentsByMessage(sessionId: string): Map<string, string> {
    const rows = this.ctx.db.connection.all(sql`
      SELECT message_id, content
      FROM rome_agent_trace_blocks
      WHERE session_id = ${sessionId}
      ORDER BY message_id ASC, seq ASC
    `) as Array<{ message_id: string; content: string }>;
    const blocksByMessage = new Map<string, string[]>();
    for (const row of rows) {
      const list = blocksByMessage.get(row.message_id);
      if (list) list.push(row.content);
      else blocksByMessage.set(row.message_id, [row.content]);
    }
    const map = new Map<string, string>();
    for (const [messageId, blocks] of blocksByMessage) {
      map.set(messageId, `[${blocks.join(",")}]`);
    }
    return map;
  }

  // Final assistant reply blocks per turn. A webchat trace row carries only the
  // agent's steps (empty for a plain text answer); the visible reply is stored
  // in sibling role=assistant rows. Pull their text blocks so an imported turn
  // shows the answer instead of "no final text message".
  private assistantTextBlocksByTurn(
    sessionId: string,
    agent: string,
  ): Map<string, TraceBlockDto[]> {
    const map = new Map<string, TraceBlockDto[]>();
    const rows = this.ctx.db.connection.all(sql`
      SELECT wm.turn_id AS turn_id, wm.content AS content
      FROM rome_agent_messages wm
      WHERE wm.session_id = ${sessionId}
        AND wm.role = 'assistant'
      ORDER BY wm.created_at ASC
    `) as Array<{ turn_id: string | null; content: string }>;
    for (const row of rows) {
      if (!row.turn_id) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.content);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      const texts = (parsed as Array<{ type?: unknown; content?: unknown }>)
        .filter((b) => b?.type === "text" && typeof b.content === "string" && b.content.trim())
        .map((b) => ({ type: "text", content: b.content as string, agent }) as TraceBlockDto);
      if (texts.length === 0) continue;
      map.set(row.turn_id, [...(map.get(row.turn_id) ?? []), ...texts]);
    }
    return map;
  }

  // Per-turn conversation blocks from the agent's assistant messages — the
  // reply text plus any interaction card — with the guardian's answer embedded
  // into each card so the replay shows the resolved state exactly where /chat
  // does. Unlike the trace steps, these are what the chat column renders.
  //
  // Matching mirrors core's `findOpenSuspensions`: a card's `toolUseId` is only
  // unique within a turn (providers recycle ids like `item_0`), so we pair an
  // `interaction_result` with the most-recent still-open card of that id in
  // chronological order. A single global toolUseId→answer map would instead let
  // a later answer overwrite an earlier card's (wrong answer on the prior card).
  //
  // Ordering matches core's `getMessages()` exactly — group rows by each turn's
  // earliest timestamp (window function), then by row time within the turn —
  // because a later turn's user row can be inserted before an earlier turn's
  // assistant reply; a plain `created_at` sort would interleave turns and pair
  // a recycled id against the wrong card.
  private replyBlocksByTurn(sessionId: string): Map<string, ReplyBlock[]> {
    const byTurn = new Map<string, ReplyBlock[]>();
    // The newest still-open card per toolUseId, awaiting its interaction_result.
    const open = new Map<string, ReplyInteractionBlock>();
    const rows = this.ctx.db.connection.all(sql`
      SELECT wm.turn_id AS turn_id, wm.role AS role, wm.content AS content
      FROM rome_agent_messages wm
      WHERE wm.session_id = ${sessionId}
        AND wm.role IN ('assistant', 'user')
      ORDER BY
        MIN(wm.created_at) OVER (PARTITION BY COALESCE(wm.turn_id, wm.id)),
        wm.created_at
    `) as Array<{ turn_id: string | null; role: string; content: string }>;
    const pushBlock = (turnId: string, block: ReplyBlock) => {
      const list = byTurn.get(turnId);
      if (list) list.push(block);
      else byTurn.set(turnId, [block]);
    };
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.content);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const raw of parsed as Array<Record<string, unknown>>) {
        if (!raw || typeof raw !== "object") continue;
        // A guardian answer closes (resolves) the most-recent open card of that id.
        if (raw.type === "interaction_result" && typeof raw.toolUseId === "string") {
          const card = open.get(raw.toolUseId);
          if (card) {
            card.result =
              raw.output && typeof raw.output === "object"
                ? (raw.output as Record<string, unknown>)
                : {};
            open.delete(raw.toolUseId);
          }
          continue;
        }
        // Only assistant messages contribute reply blocks (text + cards).
        if (row.role !== "assistant" || !row.turn_id) continue;
        if (raw.type === "text" && typeof raw.content === "string" && raw.content.trim()) {
          pushBlock(row.turn_id, { type: "text", content: raw.content });
        } else if (raw.type === "pending_interaction" && typeof raw.toolUseId === "string") {
          const render = raw.render as Record<string, unknown> | undefined;
          if (!render || typeof render.componentId !== "string") continue;
          const card: ReplyInteractionBlock = {
            type: "pending_interaction",
            toolUseId: raw.toolUseId,
            appId: typeof raw.appId === "string" ? raw.appId : undefined,
            render: {
              componentId: render.componentId,
              props:
                render.props && typeof render.props === "object"
                  ? (render.props as Record<string, unknown>)
                  : undefined,
              builtin: render.builtin === true,
            },
          };
          pushBlock(row.turn_id, card);
          open.set(card.toolUseId, card); // newest open card for this id
        }
      }
    }
    return byTurn;
  }

  private importWebchatSession(
    sessionId: string,
    options: { title?: string },
  ): { collectionId: string | null; traceCount: number; message: string } {
    const rows = this.ctx.db.connection.all(sql`
      SELECT
        ws.id AS session_id,
        ws.name AS session_name,
        ws.project_name,
        ws.project_path,
        ws.agent_name,
        ws.created_at AS session_created_at,
        wm.id AS message_id,
        wm.turn_id,
        wm.content,
        wm.created_at AS message_created_at,
        wm.input_tokens,
        wm.output_tokens,
        wm.cache_read_tokens,
        wm.cache_write_tokens,
        wm.cost_usd
      FROM rome_agent_messages wm
      JOIN rome_sessions ws ON ws.id = wm.session_id
      WHERE wm.session_id = ${sessionId}
        AND wm.role = 'trace'
        AND ws.type IN ('webchat', 'webchat_handoff')
      ORDER BY wm.created_at ASC
    `) as SourceTraceRow[];

    if (rows.length === 0) {
      return {
        collectionId: null,
        traceCount: 0,
        message: "No trace rows found for that session.",
      };
    }

    const promptsByTurn = this.userPromptsByTurn(sessionId);
    const first = rows[0];
    const assistantByTurn = this.assistantTextBlocksByTurn(sessionId, first.agent_name ?? "main");
    const traceContentByMessage = this.traceContentsByMessage(sessionId);
    const replyByTurn = this.replyBlocksByTurn(sessionId);
    const collectionId = randomUUID();
    this.repo.upsertCollection({
      id: collectionId,
      title: options.title?.trim() || first.session_name || "Imported trace session",
      description: `Imported ${rows.length} static trace${rows.length === 1 ? "" : "s"} from local chat history.`,
      source: "local-import",
    });

    rows.forEach((row, index) => {
      // The trace row holds only the agent's steps (empty for a plain text
      // reply); append the turn's final assistant text so the replay shows it.
      // Legacy sessions (pre rome_agent_trace_blocks) instead stored the full trace
      // — already ending in the final text — inline in wm.content, so skip the
      // append when the trace already carries a text block to avoid a doubled
      // reply.
      // Prefer the reassembled append-only blocks; fall back to the row's
      // inline content for legacy traces stored before rome_agent_trace_blocks.
      const traceContent = traceContentByMessage.get(row.message_id) ?? row.content;
      const traceBlocks = parseTraceBlocks(traceContent);
      const traceHasText = traceBlocks.some((b) => b.type === "text");
      const finalText = (!traceHasText && row.turn_id && assistantByTurn.get(row.turn_id)) || [];
      const blocks = [...traceBlocks, ...finalText];
      const snapshot = buildTraceSnapshot({
        idPrefix: `trace-${index}`,
        blocks,
      });
      // Conversation blocks (reply text + interaction cards, answers already
      // embedded) for turns that surfaced a card. Text-only turns keep using the
      // snapshot's final message, so leave replyBlocks unset for them.
      const turnReply = (row.turn_id && replyByTurn.get(row.turn_id)) || [];
      const hasCard = turnReply.some((b) => b.type === "pending_interaction");
      const replyBlocks = hasCard ? turnReply : undefined;
      this.repo.upsertTrace({
        collectionId,
        title: sourceTraceTitle(row, index),
        description: null,
        capturedAt: toDate(row.message_created_at),
        blocks,
        snapshot,
        metadata: {
          tags: ["local-import"],
          importedAt: new Date().toISOString(),
          userPrompt: (row.turn_id && promptsByTurn.get(row.turn_id)) || undefined,
          agentName: row.agent_name ?? undefined,
          replyBlocks,
        },
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        costUsd: row.cost_usd,
      });
    });

    return { collectionId, traceCount: rows.length, message: "Imported static trace showcase." };
  }

  private importBundle(
    bundle: ShowcaseBundle,
    sourceFallback: CollectionSource,
  ): { collectionCount: number; traceCount: number } {
    let traceCount = 0;
    for (const collection of bundle.collections) {
      const collectionId = collection.id || randomUUID();
      this.repo.upsertCollection({
        id: collectionId,
        title: collection.title || "Untitled collection",
        description: collection.description ?? null,
        source: collectionSource(collection.source, sourceFallback),
      });
      for (const trace of collection.traces) {
        const blocks = trace.blocks;
        const snapshot =
          trace.snapshot ?? buildTraceSnapshot({ idPrefix: trace.id || randomUUID(), blocks });
        this.repo.upsertTrace({
          id: trace.id || randomUUID(),
          collectionId,
          title: trace.title || "Untitled trace",
          description: trace.description ?? null,
          capturedAt: toDate(trace.capturedAt),
          blocks,
          snapshot,
          metadata: sanitizeMetadata(trace.metadata),
        });
        traceCount += 1;
      }
    }
    return { collectionCount: bundle.collections.length, traceCount };
  }

  private exportBundle(collectionIds?: string[]): ShowcaseBundle {
    const idSet = collectionIds && collectionIds.length > 0 ? new Set(collectionIds) : null;
    const collections = this.repo
      .listCollections()
      .filter((collection) => !idSet || idSet.has(collection.id));

    return {
      schema: SHOWCASE_BUNDLE_SCHEMA,
      version: SHOWCASE_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      collections: collections.map((collection) => {
        const traces = this.repo.listTraces(collection.id);
        const details = traces
          .map((trace) => this.repo.getTrace(trace.id))
          .filter((trace): trace is TraceDetail => trace !== null);
        return {
          id: collection.id,
          title: collection.title,
          description: collection.description,
          source: collection.source,
          // `snapshot` and `summary` are pure derivations of `blocks`
          // (rebuilt by buildTraceSnapshot on import / shared replay), so
          // shipping them roughly doubles the payload for no gain. Omit them:
          // it keeps the bundle within Rome Cloud's preset size cap
          // (`preset_too_large`, 5 MB) without any loss of fidelity.
          traces: details.map((trace) => ({
            id: trace.id,
            title: trace.title,
            description: trace.description,
            capturedAt: trace.capturedAt,
            blocks: trace.blocks,
            metadata: trace.metadata,
          })),
        };
      }),
    };
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new ShowcasesApiHandler(ctx);
}
