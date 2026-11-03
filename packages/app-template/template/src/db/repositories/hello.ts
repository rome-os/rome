import { desc } from "drizzle-orm";
import type { AppDbContext, DrizzleDb } from "@rome-os/app-runtime";
import { createAppDbSchema } from "../schema.js";

export interface Greeting {
  id: string;
  message: string;
  createdAt: Date;
}

export class HelloRepository {
  private readonly tables;

  constructor(
    private readonly db: DrizzleDb,
    tablePrefix: string,
  ) {
    this.tables = createAppDbSchema(tablePrefix);
  }

  recordGreeting(message: string): Greeting {
    const id = crypto.randomUUID();
    const createdAt = new Date();
    this.db.insert(this.tables.greetings).values({ id, message, createdAt }).run();
    return { id, message, createdAt };
  }

  list(): Greeting[] {
    return this.db
      .select()
      .from(this.tables.greetings)
      .orderBy(desc(this.tables.greetings.createdAt))
      .limit(50)
      .all();
  }
}

export function createHelloRepository(ctx: AppDbContext): HelloRepository {
  return new HelloRepository(ctx.connection, ctx.tablePrefix);
}
