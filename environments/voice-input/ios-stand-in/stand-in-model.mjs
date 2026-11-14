// A scripted model in the shape of Anthropic's Messages API, so the
// environment's real Rome can run a turn without a model login while
// record.mjs records. It reads nothing it is sent beyond what it needs:
//
// - A turn whose newest guardian text holds MARKER, with a tool named
//   *chat_start on offer, answers with that tool call, so Rome's own tool
//   writes a task, its task chat, its card and its thread.
// - A request that carries a tool result answers "Started.".
// - Anything else answers "Done.".
//
//   node stand-in-model.mjs [--port 8793]
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
export const MARKER = "[stand-in: start a task]";
const PORT = Number(args.port ?? 8793);
const requests = [];

function lastUserContent(body) {
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return [];
  return typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
}

function answer(body) {
  const content = lastUserContent(body);
  if (content.some((c) => c.type === "tool_result")) return { text: "Started." };
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const tool = (body.tools ?? []).find((t) => /(^|__)chat_start$/.test(t.name));
  if (tool && text.includes(MARKER))
    return {
      tool: {
        name: tool.name,
        input: {
          title: "Stand-in task",
          brief: "Reply with the word done. The stand-in instance records this task.",
        },
      },
    };
  return { text: "Done." };
}

function message(model, reply) {
  const content = reply.tool
    ? [{ type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "")}`, ...reply.tool }]
    : [{ type: "text", text: reply.text }];
  return {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: reply.tool ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function stream(res, m) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", {
    message: {
      ...m,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  m.content.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
    } else {
      send("content_block_start", {
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      send("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", {
    delta: { stop_reason: m.stop_reason, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  send("message_stop", {});
  res.end();
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://model");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {}
    if (url.pathname === "/__stand-in/requests") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(requests));
    }
    if (url.pathname.endsWith("/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    if (!url.pathname.endsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          type: "error",
          error: { type: "not_found_error", message: url.pathname },
        }),
      );
    }
    const reply = answer(body);
    requests.push({
      at: new Date().toISOString(),
      tools: (body.tools ?? []).length,
      reply: reply.tool ? reply.tool.name : reply.text,
    });
    const m = message(body.model ?? "stand-in", reply);
    if (body.stream) return stream(res, m);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(m));
  });
}).listen(PORT, "0.0.0.0", () => console.log(`stand-in model on :${PORT}`));
