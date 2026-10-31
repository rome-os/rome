import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync } from "node:fs";

// A loopback stand-in for the Anthropic Messages API. Rome's real Claude
// provider spawns the real Claude CLI with ANTHROPIC_BASE_URL pointed here, so
// everything above the model (CLI, Agent SDK, MCP tools, sessions, traces,
// transcripts) runs the code that ships. Replies are scripted by directives in
// the latest user text, so a browser test controls what the model says without
// a control channel of its own.
//
// Directives (anywhere in the newest user text):
//   E2E-REPLY <token>     → text "Reply to <token>"
//   E2E-SUBAGENT <token>  → calls Rome's assistant:assistant subagent with prompt
//                           "E2E-CHILD <token>", then answers "Parent done <token>"
//   E2E-CHILD <token>     → text "Child says <token>" (the subagent's turn)
//   E2E-SLOW <token>      → text "Slow reply to <token>", sent after 4 s, so a
//                           test can leave the chat before the reply lands
// Rome's conversation-title request (the StructuredOutput tool) is answered
// with the title "Topic <token>". Anything else, such as the CLI's own session
// naming or Rome's background turns, is answered "OK" or a schema-shaped
// stand-in.

interface ContentBlock {
  type: string;
  text?: string;
  content?: unknown;
  name?: string;
  id?: string;
  tool_use_id?: string;
}

interface MessagesRequest {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role: string; content: string | ContentBlock[] }>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  output_config?: { format?: { type?: string } };
}

type Reply =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; input: Record<string, unknown> };

export interface ModelCall {
  model: string;
  directive: string | null;
  reply: Reply;
  /** The tools the request offered, by name. */
  tools: string[];
}

const DIRECTIVE = /E2E-(REPLY|SUBAGENT|CHILD|SLOW) ([A-Za-z0-9_-]+)/g;
const SLOW_REPLY_MS = 4_000;

function textOf(content: string | ContentBlock[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "tool_result")
        return typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      return "";
    })
    .join("\n");
}

function lastDirective(text: string): { verb: string; token: string } | null {
  let found: { verb: string; token: string } | null = null;
  for (const match of text.matchAll(DIRECTIVE)) found = { verb: match[1]!, token: match[2]! };
  return found;
}

/** The tool that runs one of Rome's subagents. Rome offers each allowed
 *  subagent as its own MCP tool, `mcp__subagents__sa_<hash>`, described by the
 *  subagent's name; the suite delegates to `assistant:assistant`. */
function subagentTool(request: MessagesRequest): string | undefined {
  const tools = (request.tools ?? []).filter((tool) => tool.name.startsWith("mcp__subagents__"));
  return (tools.find((tool) => tool.description?.includes("assistant:assistant")) ?? tools[0])
    ?.name;
}

function decideReply(request: MessagesRequest): { directive: string | null; reply: Reply } {
  // The CLI interleaves `system` entries (reminders, token budgets) with the
  // conversation, so only user and assistant turns are read.
  const turns = (request.messages ?? []).filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const blocksOf = (message: (typeof turns)[number]) =>
    Array.isArray(message.content) ? message.content : [];
  const isToolResult = (message: (typeof turns)[number]) =>
    message.role === "user" &&
    blocksOf(message).length > 0 &&
    blocksOf(message).every((block) => block.type === "tool_result");

  // Tool calls answered since the newest user text, by tool name.
  const answered = new Set<string>();
  let directive: { verb: string; token: string } | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const message = turns[i]!;
    if (message.role === "assistant") {
      for (const block of blocksOf(message))
        if (block.type === "tool_use" && block.name) answered.add(block.name);
      continue;
    }
    if (isToolResult(message)) continue;
    // Only the newest user text counts: an older directive must not answer a
    // newer, plain message.
    directive = lastDirective(textOf(message.content));
    break;
  }

  const label = directive ? `${directive.verb} ${directive.token}` : null;
  const text = (value: string) => ({
    directive: label,
    reply: { kind: "text", text: value } as Reply,
  });
  const tool = (name: string, input: Record<string, unknown>) => ({
    directive: label,
    reply: { kind: "tool_use", name, input } as Reply,
  });

  // Rome names a new chat through a one-turn structured request.
  if ((request.tools ?? []).some((t) => t.name === "StructuredOutput")) {
    if (answered.has("StructuredOutput")) return text("OK");
    return tool("StructuredOutput", { title: `Topic ${directive?.token ?? "untitled"}` });
  }
  // The CLI's own JSON-shaped side requests (session naming).
  if (request.output_config?.format?.type === "json_schema")
    return text(JSON.stringify({ title: "E2E session" }));

  if (!directive) return text("OK");
  const { verb, token } = directive;
  if (verb === "REPLY") return text(`Reply to ${token}`);
  if (verb === "CHILD") return text(`Child says ${token}`);
  if (verb === "SLOW") return text(`Slow reply to ${token}`);

  // SUBAGENT
  const delegate = subagentTool(request);
  if (!delegate) return text(`No subagent tool was offered for ${token}`);
  if (answered.has(delegate)) return text(`Parent done ${token}`);
  return tool(delegate, { prompt: `E2E-CHILD ${token}` });
}

let messageSeq = 0;

function messageBody(model: string, reply: Reply) {
  const id = `msg_e2e_${++messageSeq}`;
  const content =
    reply.kind === "text"
      ? [{ type: "text", text: reply.text }]
      : [{ type: "tool_use", id: `toolu_e2e_${messageSeq}`, name: reply.name, input: reply.input }];
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: reply.kind === "text" ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function writeStream(res: ServerResponse, model: string, reply: Reply): void {
  const body = messageBody(model, reply);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "request-id": `req_${body.id}`,
  });
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      ...body,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  const block = body.content[0]!;
  if (block.type === "text") {
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: (block as { text: string }).text },
    });
  } else {
    const tool = block as { id: string; name: string; input: unknown };
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
    });
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
    });
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: body.stop_reason, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export class FakeAnthropic {
  readonly calls: ModelCall[] = [];
  readonly unhandled: string[] = [];
  private readonly server: Server = createServer((req, res) => {
    void this.handle(req, res).catch((error: unknown) => {
      this.unhandled.push(`error ${req.method} ${req.url}: ${String(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async start(port = 0): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(port, "127.0.0.1", resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST" && path === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (req.method === "POST" && path === "/v1/messages") {
      const request = (await readJson(req)) as MessagesRequest;
      // Set E2E_MODEL_LOG to a file path to keep every request for debugging.
      if (process.env.E2E_MODEL_LOG)
        appendFileSync(process.env.E2E_MODEL_LOG, `${JSON.stringify(request)}\n`);
      const model = request.model ?? "claude-e2e";
      const { directive, reply } = decideReply(request);
      this.calls.push({ model, directive, reply, tools: (request.tools ?? []).map((t) => t.name) });
      if (directive?.startsWith("SLOW ") && reply.kind === "text" && reply.text.startsWith("Slow"))
        await new Promise((done) => setTimeout(done, SLOW_REPLY_MS));
      if (request.stream) writeStream(res, model, reply);
      else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(messageBody(model, reply)));
      }
      return;
    }
    this.unhandled.push(`${req.method} ${path}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: path } }));
  }
}
