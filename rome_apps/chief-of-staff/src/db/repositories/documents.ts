import { eq } from "drizzle-orm";
import type { AppDbContext, DrizzleDb } from "@rome-os/app-runtime";
import { createAppDbSchema } from "../schema.js";

/** The two documents the team owns. No other name is a document. */
export const DOCUMENT_NAMES = ["roster", "goals"] as const;
export type DocumentName = (typeof DOCUMENT_NAMES)[number];

export function isDocumentName(value: string): value is DocumentName {
  return (DOCUMENT_NAMES as readonly string[]).includes(value);
}

export interface TeamDocument {
  name: DocumentName;
  body: string;
  updatedAt: string | null;
}

/** Reads and replaces the roster and the goals document. A document never
 *  read before reads as empty with no update time, so the agent and the UI
 *  always have both to show. */
export class DocumentsRepository {
  private readonly tables;

  constructor(
    private readonly db: DrizzleDb,
    tablePrefix = "chief_of_staff",
  ) {
    this.tables = createAppDbSchema(tablePrefix);
  }

  get(name: DocumentName): TeamDocument {
    const row = this.db
      .select()
      .from(this.tables.documents)
      .where(eq(this.tables.documents.name, name))
      .get();
    return { name, body: row?.body ?? "", updatedAt: row?.updatedAt ?? null };
  }

  all(): TeamDocument[] {
    return DOCUMENT_NAMES.map((name) => this.get(name));
  }

  /** Replace a document whole: the team edits it as one piece. */
  set(name: DocumentName, body: string): TeamDocument {
    const updatedAt = new Date().toISOString();
    this.db
      .insert(this.tables.documents)
      .values({ name, body, updatedAt })
      .onConflictDoUpdate({
        target: this.tables.documents.name,
        set: { body, updatedAt },
      })
      .run();
    return { name, body, updatedAt };
  }
}

export function createDocumentsRepository(ctx: AppDbContext): DocumentsRepository {
  return new DocumentsRepository(ctx.connection, ctx.tablePrefix);
}
