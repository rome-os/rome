import { type FileHandle, lstat, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import type { ChatOutputDto, ChatOutputSource } from "@rome/api-types/chat-outputs";
import { openRegularFile, resolveShowablePath } from "../../assets/store.js";
import { createLogger } from "../../logger.js";
import { getAssetsDir, getProjectsRoot } from "../../paths.js";
import type { BackfillMessage, ChatOutputRow, ChatOutputsRepository } from "./repository.js";

const log = createLogger("chat-outputs");

/** The few facts of a chat the list reads. */
export interface OutputChat {
  id: string;
  /** The absolute folder of the chat's project, where a relative path written in it lies. */
  projectDir?: string | null;
}

export interface ChatOutputsDeps {
  repo: Pick<
    ChatOutputsRepository,
    "listFor" | "get" | "backfill" | "needingBackfill" | "recordingSince" | "subagentRoots"
  >;
  /** A chat's stored messages, its traces included, read once to back fill its outputs. */
  messages: (id: string) => Promise<readonly BackfillMessage[]>;
  /** A chat's facts, or null when it is gone. */
  chat: (id: string) => Promise<OutputChat | null>;
  /** Folders a written file is read in: test seam. */
  roots?: { projects: string; assets: string; showable?: string[] };
}

/** An output's file, open: read it from `handle`, which the caller closes. */
export interface OpenOutputFile {
  handle: FileHandle;
  size: number;
  /** The path that was opened, for its type. */
  path: string;
  name: string;
}

/** A chat's outputs, and whether earlier ones are still being read back. */
export interface OutputsList {
  outputs: ChatOutputDto[];
  indexing: boolean;
}

/** An output resolved to the file on disk it stands for. */
interface Located {
  row: ChatOutputRow;
  /** The absolute local path, of the written file or the shown copy. */
  file: string;
  /** What makes two records the same file. */
  identity: string;
}

/**
 * A chat's outputs: the files its agent wrote or showed, read from the
 * records the trace left, newest first and one per file.
 * docs/domains/chats.md#outputs
 */
export class ChatOutputs {
  constructor(private deps: ChatOutputsDeps) {}

  private recordedSince: Date | null = null;

  /**
   * When outputs began to be recorded as they happen; chats made since need no
   * reading back. Read on first use, so mounting the routes touches no table.
   */
  private get since(): Date {
    this.recordedSince ??= this.deps.repo.recordingSince();
    return this.recordedSince;
  }

  private get projectsRoot() {
    return this.deps.roots?.projects ?? getProjectsRoot();
  }

  private get assetsDir() {
    return this.deps.roots?.assets ?? getAssetsDir();
  }

  /** Chats waiting to be read back, in order; the first is being read. */
  private backfillQueue = new Set<string>();
  private backfilling: Promise<void> | null = null;

  /**
   * Chat `chatId`'s outputs, its subagents' included. `taskChats` are the
   * task chats a Concierge chat started: their outputs are listed too, each
   * tagged with the chat it came from. A chat from before outputs were
   * recorded is read back in the background, one chat at a time, and the list
   * says so with `indexing` until it is done.
   */
  async list(chatId: string, taskChats: readonly ChatOutputSource[] = []): Promise<OutputsList> {
    const { sessionIds, fromTask } = await this.sessionsOf(chatId, taskChats);
    const waiting = this.deps.repo.needingBackfill(sessionIds, this.since);
    this.scheduleBackfill(waiting);
    const rows = await this.deps.repo.listFor(sessionIds);
    const chats = new Map<string, OutputChat | null>();
    const chatOf = async (id: string) => {
      if (!chats.has(id)) chats.set(id, await this.deps.chat(id));
      return chats.get(id) ?? null;
    };
    const located: Located[] = [];
    for (const row of rows) located.push(this.locate(row, await chatOf(row.sessionId)));

    // A shown copy stands for the file it was copied from, when one record
    // names it, so a file written and then shown is one output.
    const copiedFrom = new Map<string, string>();
    for (const entry of located) {
      if (entry.row.kind === "shown" && entry.row.sourcePath) {
        copiedFrom.set(entry.row.path, entry.identity);
      }
    }
    const newest = new Map<string, Located>();
    for (const entry of located) {
      const identity =
        entry.row.kind === "shown" && !entry.row.sourcePath
          ? (copiedFrom.get(entry.row.path) ?? entry.identity)
          : entry.identity;
      // Rows come newest first, so the first one per file wins.
      if (!newest.has(identity)) newest.set(identity, entry);
    }

    return {
      outputs: await Promise.all(
        [...newest.values()].map((entry) => this.toDto(chatId, entry, fromTask)),
      ),
      indexing: waiting.length > 0,
    };
  }

  /** The chat, its task chats, and the subagent sessions under each, by what they stand for. */
  private async sessionsOf(chatId: string, taskChats: readonly ChatOutputSource[]) {
    const task = new Map(taskChats.map((chat) => [chat.chatId, chat]));
    const roots = await this.deps.repo.subagentRoots([chatId, ...task.keys()]);
    const fromTask = new Map<string, ChatOutputSource>();
    const sessionIds = [chatId, ...task.keys()];
    for (const [id, chat] of task) fromTask.set(id, chat);
    for (const [sub, root] of roots) {
      sessionIds.push(sub);
      const from = task.get(root);
      if (from) fromTask.set(sub, from);
    }
    return { sessionIds, fromTask };
  }

  /** Queues chats `ids` to be read back, and starts the reader when it is idle. */
  private scheduleBackfill(ids: readonly string[]): void {
    for (const id of ids) this.backfillQueue.add(id);
    if (this.backfilling || this.backfillQueue.size === 0) return;
    this.backfilling = this.runBackfill().finally(() => {
      this.backfilling = null;
    });
  }

  /** Reads the queued chats back one at a time, yielding to requests between them. */
  private async runBackfill(): Promise<void> {
    for (const id of this.backfillQueue) {
      await nextTick();
      try {
        this.deps.repo.backfill(id, await this.deps.messages(id));
      } catch (error) {
        log.warn("could not read back a chat's earlier outputs", {
          sessionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.backfillQueue.delete(id);
    }
  }

  /** Settles once every queued read back has run: test seam. */
  async backfillsSettled(): Promise<void> {
    while (this.backfilling) await this.backfilling;
  }

  /**
   * Opens the file behind output `outputId` of chat `chatId`'s list, or null
   * when the list has no such output or its file cannot be served. The file
   * is opened without following a link and checked on the open descriptor,
   * so what is read is what was checked.
   */
  async open(
    chatId: string,
    outputId: string,
    taskChats: readonly ChatOutputSource[] = [],
  ): Promise<OpenOutputFile | null> {
    const row = await this.deps.repo.get(outputId);
    if (!row) return null;
    const { sessionIds } = await this.sessionsOf(chatId, taskChats);
    if (!sessionIds.includes(row.sessionId)) return null;
    const entry = this.locate(row, await this.deps.chat(row.sessionId));
    const path = await this.servable(entry);
    if (!path) return null;
    try {
      const { handle, size } = await openRegularFile(path);
      return { handle, size, path, name: row.name };
    } catch {
      return null;
    }
  }

  private locate(row: ChatOutputRow, chat: OutputChat | null): Located {
    if (row.kind === "shown") {
      const file = join(this.assetsDir, basename(row.path));
      return { row, file, identity: row.sourcePath ? resolve(row.sourcePath) : row.path };
    }
    // A relative path is the chat's project's, as the tool read it.
    const file = isAbsolute(row.path)
      ? resolve(row.path)
      : resolve(chat?.projectDir ?? this.projectsRoot, row.path);
    return { row, file, identity: file };
  }

  /** The real path to serve an output from, or null when it is gone or may not be served. */
  private async servable(entry: Located): Promise<string | null> {
    if (entry.row.kind === "shown") {
      try {
        // lstat: a link planted in the store is never followed.
        return (await lstat(entry.file)).isFile() ? entry.file : null;
      } catch {
        return null;
      }
    }
    try {
      const real = await resolveShowablePath(entry.file, this.deps.roots?.showable);
      return (await stat(real)).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  private async exists(entry: Located): Promise<boolean> {
    try {
      return (await (entry.row.kind === "shown" ? lstat : stat)(entry.file)).isFile();
    } catch {
      return false;
    }
  }

  /** The link a chat message gives the file, in the projects folder or the asset store. */
  private link(entry: Located): string | null {
    if (entry.row.kind === "shown") return entry.row.path;
    const rel = relative(this.projectsRoot, entry.file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return `/projects/${rel.split(sep).join("/")}`;
  }

  private async toDto(
    chatId: string,
    entry: Located,
    fromTask: ReadonlyMap<string, ChatOutputSource>,
  ): Promise<ChatOutputDto> {
    const { row } = entry;
    const missing = !(await this.exists(entry));
    const served = missing ? null : await this.servable(entry);
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      path: row.path,
      link: this.link(entry),
      mimeType: row.mimeType,
      at: row.createdAt.toISOString(),
      turnId: row.turnId,
      messageId: row.messageId,
      missing,
      from: fromTask.get(row.sessionId) ?? null,
      contentUrl: served
        ? `/api/chat/sessions/${encodeURIComponent(chatId)}/outputs/${encodeURIComponent(row.id)}/content`
        : null,
    };
  }
}
