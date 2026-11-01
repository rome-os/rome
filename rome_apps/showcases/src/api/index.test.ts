import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { TurnLinks } from "../../../../packages/core/src/sessions/turn-links.js";
import { WebChatRepository } from "../../../../packages/core/src/db/repositories/webchat.js";
import {
  createTestDb,
  testAppRepositories,
  type TestDb,
} from "../../../../packages/core/src/test/helpers.js";
import { seatFixture } from "../../../../packages/core/src/test/seats.js";
import { createApiHandler } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../db/migrations");

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
  migrate(testDb.db as never, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: "__drizzle_migrations_app_showcases",
  });
});

afterEach(() => {
  testDb.close();
});

function handler() {
  return createApiHandler({
    app: { id: "showcases", version: "0.0.0" },
    repositories: testAppRepositories(testDb.db),
    db: {
      connection: testDb.db,
      tablePrefix: "showcases",
      tableName: (name: string) => `showcases__${name}`,
    },
  } as unknown as RomeAppContext);
}

function request(method: string, path: string, body?: unknown): RomeAppApiRequest {
  return {
    method,
    path: path.split("/"),
    headers: {},
    query: new URLSearchParams(),
    body: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)),
  } as RomeAppApiRequest;
}

const text = (value: string) => JSON.stringify([{ type: "text", content: value }]);

// One turn as core stores it: the guardian's input and the reply as lines of
// the chat, and a '[]' trace stub, the agent's own row, whose blocks live in
// rome_agent_trace_blocks. A channel seat stands in a Telegram group and a
// background run in no chat.
async function seedSession(id: string, type: string, at: number): Promise<void> {
  const repo = new WebChatRepository(testDb.db);
  if (type === "channel") {
    const fixture = seatFixture(testDb.db);
    const chat = fixture.chat("telegram", `telegram:${id}`, "group");
    fixture.seat({ id, chat, accountId: "telegram-bot", name: `${id} chat` });
  } else if (type === "action") {
    await repo.ensureRomeSession({ id, name: `${id} chat`, type: "action", agentName: null });
  } else {
    await repo.createSession(id, `${id} chat`);
    if (type === "webchat_handoff") {
      testDb.db.run(sql`UPDATE rome_sessions SET type = 'webchat_handoff' WHERE id = ${id}`);
    }
  }
  testDb.db.run(
    sql`UPDATE rome_sessions SET created_at = ${at}, activity_at = ${at} WHERE id = ${id}`,
  );
  if (type === "channel" || type === "action") return;
  await repo.recordUserInput(`${id}-user`, id, text(`${id} question`));
  new TurnLinks(testDb.db).promptRuns(id, `${id}-user`, `${id}-turn`);
  await repo.addMessage(`${id}-trace`, id, "trace", "[]", `${id}-turn`);
  await repo.addMessage(`${id}-assistant`, id, "assistant", text(`${id} answer`), `${id}-turn`);
  testDb.db.run(sql`
    INSERT INTO rome_agent_trace_blocks (message_id, seq, session_id, content)
    VALUES (${`${id}-trace`}, 0, ${id},
      ${JSON.stringify({ type: "tool_use", id: "t1", name: "search", input: {} })})
  `);
  testDb.db.run(sql`UPDATE rome_sessions SET activity_at = ${at} WHERE id = ${id}`);
}

describe("showcases webchat sources", () => {
  it("lists webchat and handoff sessions, not channel or background runs", async () => {
    await seedSession("web", "webchat", 1700000000);
    await seedSession("handoff", "webchat_handoff", 1700000100);
    await seedSession("group", "channel", 1700000200);
    await seedSession("bg", "action", 1700000300);

    const res = await handler().handle(request("GET", "sources/sessions"));

    expect(res.status).toBe(200);
    const { sessions } = (await res.json()) as { sessions: Array<{ id: string }> };
    expect(sessions.map((s) => s.id)).toEqual(["handoff", "web"]);
  });

  it("imports a webchat session with its prompt, steps and reply", async () => {
    await seedSession("web", "webchat", 1700000000);

    const api = handler();
    const res = await api.handle(request("POST", "imports/webchat-session", { sessionId: "web" }));

    expect(res.status).toBe(200);
    const imported = (await res.json()) as { collectionId: string; traceCount: number };
    expect(imported.traceCount).toBe(1);

    const list = await api.handle(request("GET", `collections/${imported.collectionId}/traces`));
    const { traces } = (await list.json()) as {
      traces: Array<{ id: string; metadata: { userPrompt?: string } }>;
    };
    expect(traces).toHaveLength(1);
    expect(traces[0].metadata.userPrompt).toBe("web question");

    const raw = await api.handle(request("GET", `traces/${traces[0].id}/raw.json`));
    const blocks = JSON.stringify(await raw.json());
    expect(blocks).toContain('"name":"search"');
    expect(blocks).toContain("web answer");
  });
});
