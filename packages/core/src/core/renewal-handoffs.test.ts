import { describe, expect, it } from "@rstest/core";
import {
  executedActionsOf,
  keyArguments,
  createRenewalHandoffs,
  recentMessagesOf,
  rowsSince,
  type ChatRow,
} from "./renewal-handoffs.js";
import type { ModelResolver } from "../agent/index.js";

const row = (role: string, text: string, turnId: string | null): ChatRow => ({
  role,
  content: JSON.stringify([{ type: "text", content: text }]),
  turnId,
  createdAt: new Date(0),
});

const unusedResolver: ModelResolver = {
  resolve: async () => {
    throw new Error("no model in this test");
  },
};

// Split so a secret scanner never reads a literal Basic credential; it is base64 of a fake "alice:hunter2".
const BASIC_CREDENTIAL = "YWxpY2U6" + "aHVudGVyMg";

describe("recentMessagesOf", () => {
  it("names who said each line, and leaves out traces and the running turn's rows", () => {
    const rows = [
      row("user", "Book dinner", "t1"),
      row("assistant", "Booked for 7", "t1"),
      row("trace", "[]", "t1"),
      row("user", "Thanks", "t2"),
    ];
    expect(recentMessagesOf(rows, "t2").map((m) => `${m.senderName}: ${m.text}`)).toEqual([
      "Guardian: Book dinner",
      "You: Booked for 7",
    ]);
  });
});

describe("recentMessagesOf with an owner", () => {
  it("names the owner's lines as the chat's owner, and Rome's as before", () => {
    const rows = [row("user", "Book dinner", "t1"), row("assistant", "Done", "t1")];
    expect(recentMessagesOf(rows, undefined, "Visitor (Ana)").map((m) => m.senderName)).toEqual([
      "Visitor (Ana)",
      "You",
    ]);
  });
});

describe("createRenewalHandoffs", () => {
  it("reads the open tasks and recent messages a successor's first turn shows", async () => {
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 30_000,
      modelResolver: unusedResolver,
      page: async () => ({
        rows: [row("user", "Book dinner", "t1"), row("user", "Now?", "t2")],
        next: null,
      }),
      openTasks: async () => "- t-1 · Book dinner · active",
    });
    const context = await handoffs.context("chat-1", "t2");
    expect(context.openTasks).toBe("- t-1 · Book dinner · active");
    expect(context.recent.map((m) => m.text)).toEqual(["Book dinner"]);
  });

  it("writes no fallback for a session in no chat, or a chat with nothing said", async () => {
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 30_000,
      modelResolver: unusedResolver,
      page: async () => ({ rows: [], next: null }),
      openTasks: async () => null,
    });
    expect(await handoffs.fallback(undefined, "concierge")).toBeNull();
    expect(await handoffs.fallback("chat-1", "concierge")).toBeNull();
  });

  it("gives up on the small model at its deadline, even when its session never closes", async () => {
    const stalled: ModelResolver = {
      resolve: async () =>
        ({
          model: "small",
          modelProvider: {
            id: "mock",
            openSession: async () => ({
              events: (async function* () {
                await new Promise(() => {});
              })(),
              sendUserInput: async () => {},
              interrupt: async () => {},
              close: () => new Promise<void>(() => {}),
            }),
          },
        }) as never,
    };
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 20,
      modelResolver: stalled,
      page: async () => ({ rows: [row("user", "dinner at 7", "t1")], next: null }),
      openTasks: async () => null,
    });
    const started = Date.now();
    await expect(handoffs.fallback("chat-1", "concierge")).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("says the chat is tidying up while a handoff is written, and only for a chat", async () => {
    const tidied: string[] = [];
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 30_000,
      modelResolver: unusedResolver,
      page: async () => ({ rows: [], next: null }),
      openTasks: async () => null,
      tidying: async (chatId, work) => {
        tidied.push(chatId);
        return work();
      },
    });
    expect(await handoffs.tidying("chat-1", async () => "note")).toBe("note");
    expect(await handoffs.tidying(undefined, async () => "none")).toBe("none");
    expect(tidied).toEqual(["chat-1"]);
  });
});

describe("every message since a time", () => {
  const at = (role: string, text: string, turnId: string | null, seconds: number): ChatRow => ({
    ...row(role, text, turnId),
    createdAt: new Date(seconds * 1_000),
  });

  it("keeps a turn whole when any of its rows is at or after the time", () => {
    const rows = [
      at("user", "Old", "t1", 10),
      at("assistant", "Old reply", "t1", 11),
      // Saved before the session opened at 20.5 s, answered after.
      at("user", "Opening request", "t2", 20),
      at("assistant", "Opening reply", "t2", 25),
      at("user", "Later", "t3", 30),
    ];
    expect(rowsSince(rows, new Date(20_500)).map((r) => r.content)).toEqual(
      rows.slice(2).map((r) => r.content),
    );
  });

  it("pages back only until a page reaches before the time", async () => {
    const pages: ChatRow[][] = [
      [at("user", "Newest", "t3", 30)],
      [at("user", "Middle", "t2", 20)],
      [at("user", "Oldest", "t1", 10)],
    ];
    let reads = 0;
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 30_000,
      modelResolver: unusedResolver,
      page: async (_chatId, _limit, before) => {
        const index = (before as number | undefined) ?? 0;
        reads += 1;
        return { rows: pages[index]!, next: index + 1 < pages.length ? index + 1 : null };
      },
      openTasks: async () => null,
    });
    const context = await handoffs.context("chat-1", "t-now", new Date(15_000));
    expect(context.recent.map((m) => m.text)).toEqual(["Middle", "Newest"]);
    expect(reads).toBe(3);
    const near = await handoffs.context("chat-1", "t-now", new Date(25_000));
    expect(near.recent.map((m) => m.text)).toEqual(["Newest"]);
    expect(reads).toBe(5);
  });

  it("does not stop at a trace older than the time, which comes with its turn's messages", async () => {
    const pages: ChatRow[][] = [
      [at("trace", "[]", "t3", 5), at("user", "Newest", "t3", 30)],
      [at("user", "Middle", "t2", 20)],
      [at("user", "Oldest", "t1", 10)],
    ];
    const handoffs = createRenewalHandoffs({
      timeoutMs: 30_000,
      fallbackTimeoutMs: 30_000,
      modelResolver: unusedResolver,
      page: async (_chatId, _limit, before) => {
        const index = (before as number | undefined) ?? 0;
        return { rows: pages[index]!, next: index + 1 < pages.length ? index + 1 : null };
      },
      openTasks: async () => null,
    });
    const context = await handoffs.context("chat-1", "t-now", new Date(15_000));
    expect(context.recent.map((m) => m.text)).toEqual(["Middle", "Newest"]);
  });
});

describe("recentMessagesOf cut eligibility", () => {
  it("marks only the agent's messages as cuttable, since a notice may be the guardian's", () => {
    const rows = [
      row("user", "a", "t1"),
      row("assistant", "b", "t1"),
      row("notification", "c", "t2"),
    ];
    expect(recentMessagesOf(rows).map((m) => m.agent === true)).toEqual([false, true, false]);
  });
});

describe("the executed-actions list", () => {
  const trace = (turnId: string, blocks: unknown[]) => ({
    role: "trace",
    content: JSON.stringify(blocks),
    turnId,
    createdAt: new Date("2026-11-19T10:00:00Z"),
  });

  it("lists the tools the latest turns called, with key arguments and no results", () => {
    const list = executedActionsOf([
      { role: "user", content: "[]", turnId: "t1", createdAt: new Date() },
      trace("t1", [
        {
          type: "tool_use",
          tool: "send_email",
          id: "a",
          input: { to: "a@b.c", body: "x".repeat(200) },
        },
        { type: "tool_result", tool: "send_email", toolUseId: "a", output: "sent: secret id 42" },
        { type: "tool_use", tool: "create_event", id: "b", input: { title: "Dentist" } },
        { type: "tool_result", tool: "create_event", toolUseId: "b", output: "no", isError: true },
      ]),
    ]);
    expect(list).toContain("- send_email(to: a@b.c, body: xxxx");
    expect(list).toContain("…)");
    expect(list).toContain("- create_event(title: Dentist) (failed)");
    expect(list).not.toContain("secret id 42");
  });

  it("carries no credentials nested in arguments, nor what is typed into a password field", () => {
    const list =
      executedActionsOf([
        trace("t1", [
          {
            type: "tool_use",
            tool: "http_request",
            id: "a",
            input: {
              url: "https://example.com/login",
              body: { user: "ada", login: { password: "hunter2", otpSecret: "JBSWY3DP" } },
              steps: [{ field: "#email", value: "ada@example.com" }],
            },
          },
          {
            type: "tool_use",
            tool: "browser_type",
            id: "b",
            input: { element: "Password input", ref: "e12", text: "correct horse battery" },
          },
          {
            type: "tool_use",
            tool: "browser_fill",
            id: "c",
            input: { fields: [{ selector: "input[type=password]", value: "s3cret-pw" }] },
          },
          {
            type: "tool_use",
            tool: "enter_one_time_code",
            id: "d",
            input: { text: "482913" },
          },
        ]),
      ]) ?? "";
    for (const leaked of ["hunter2", "JBSWY3DP", "correct horse battery", "s3cret-pw", "482913"]) {
      expect(list).not.toContain(leaked);
    }
    // What is not a secret still says what was done.
    expect(list).toContain("ada@example.com");
    expect(list).toContain("Password input");
  });

  it("carries no credentials: secret-named arguments are left out, credential-like values masked", () => {
    const list =
      executedActionsOf([
        trace("t1", [
          {
            type: "tool_use",
            tool: "http_request",
            id: "a",
            input: {
              url: "https://api.example.com/v1/items",
              apiKey: "abc",
              password: "hunter2",
              access_token: "tok",
              Cookie: "sid=1",
              headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig" },
              note: "use sk-proj-ABCDEFGHIJKLMNOP1234 here",
              digest: "0123456789abcdef0123456789abcdef01234567",
              blob: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw",
            },
          },
        ]),
      ]) ?? "";
    expect(list).toContain("url: https://api.example.com/v1/items");
    for (const leaked of [
      "abc",
      "hunter2",
      "tok",
      "sid=1",
      "eyJhbGciOiJIUzI1NiJ9",
      "sk-proj-ABCDEFGHIJKLMNOP1234",
      "0123456789abcdef0123456789abcdef01234567",
      "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw",
    ]) {
      expect(list).not.toContain(leaked);
    }
    expect(list).toContain("[redacted]");
  });

  it("reads only the last five turns, and nothing when no tool ran", () => {
    const rows = ["t1", "t2", "t3", "t4", "t5", "t6"].map((turnId) =>
      trace(turnId, [{ type: "tool_use", tool: `tool_${turnId}`, input: {} }]),
    );
    const list = executedActionsOf(rows) ?? "";
    expect(list).not.toContain("tool_t1");
    expect(list).toContain("tool_t6");
    expect(executedActionsOf([trace("t1", [{ type: "text", content: "hi" }])])).toBeNull();
  });
});

describe("credentials inside a command or a URL", () => {
  const shown = (command: string) => keyArguments({ command }, "Bash");

  it.each([
    [
      "a URL's user and password",
      "git clone https://alice:hunter2@example.com/repo.git",
      "hunter2",
      "https://[redacted]@example.com",
    ],
    [
      "a URL's token as its user",
      "curl https://ghp_token@github.com/x",
      "ghp_token",
      "https://[redacted]@github.com",
    ],
    [
      "-u user:password",
      "curl -u alice:hunter2 https://api.example.com",
      "hunter2",
      "-u [redacted]",
    ],
    [
      "--user=user:password",
      "curl --user=alice:hunter2 https://api.example.com",
      "hunter2",
      "--user=[redacted]",
    ],
    [
      "a secret-named environment assignment",
      "PGPASSWORD=short-secret psql -h db",
      "short-secret",
      "PGPASSWORD=[redacted]",
    ],
    [
      "an API key exported",
      "export OPENAI_API_KEY='abc 123' && run",
      "abc 123",
      "OPENAI_API_KEY=[redacted]",
    ],
    [
      "an Authorization header",
      `curl -H "Authorization: Basic ${BASIC_CREDENTIAL}" https://x`,
      BASIC_CREDENTIAL,
      "Authorization: [redacted]",
    ],
    [
      "a bearer token",
      "curl -H 'X-Trace: 1' -H 'authorization: Bearer abc.def' https://x",
      "abc.def",
      "authorization: [redacted]",
    ],
    ["--password", "mysql --password hunter2 db", "hunter2", "--password [redacted]"],
    ["--token=", "gh auth --token=gho_short db", "gho_short", "--token=[redacted]"],
    ["a password glued to -p", "mysql -uroot -phunter2 db", "hunter2", "-p[redacted]"],
    ["sshpass -p", "sshpass -p 'hunter 2' ssh host", "hunter 2", "sshpass -p [redacted]"],
  ])("masks %s", (_label, command, secret, kept) => {
    const text = shown(command);
    expect(text).not.toContain(secret);
    expect(text).toContain(kept);
  });

  it("leaves a command with no credential readable", () => {
    expect(shown("mkdir -p build && sort -u names.txt && ssh -p 2222 host")).toBe(
      "command: mkdir -p build && sort -u names.txt && ssh -p 2222 host",
    );
  });

  it("keeps them out of the executed-actions list a chat carries to another provider", () => {
    const list =
      executedActionsOf([
        {
          role: "trace",
          turnId: "t1",
          createdAt: new Date(0),
          content: JSON.stringify([
            {
              type: "tool_use",
              tool: "Bash",
              id: "a",
              input: { command: "curl -u alice:hunter2 https://bob:pw@x.example" },
            },
          ]),
        },
      ]) ?? "";
    expect(list).toContain("Bash(");
    expect(list).not.toContain("hunter2");
    expect(list).not.toContain("bob:pw");
  });
});
