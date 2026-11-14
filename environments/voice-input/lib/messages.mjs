// Reads a chat's stored messages (Rome's GET /api/chat/sessions/:id/messages
// on stdin) and prints them as the verifier compares them: who sent each,
// its text, and its attachments. Rome's step traces are left out.
//
//   node messages.mjs <chat id>
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const body = JSON.parse(raw);
const list = Array.isArray(body) ? body : (body.messages ?? []);

function parts(content) {
  if (Array.isArray(content)) return content;
  if (typeof content !== "string") return [];
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [{ type: "text", content }];
  } catch {
    return [{ type: "text", content }];
  }
}

const messages = list
  .filter((m) => m.role !== "trace")
  .map((m) => {
    const all = parts(m.content);
    const text = all
      .filter((p) => p.type === "text")
      .map((p) => p.content ?? p.text ?? "")
      .join("");
    const attachments = all
      .filter((p) => p.type !== "text")
      .map(({ type, name, mimeType, mediaType, url, assetId, id, error }) => ({
        type,
        name,
        mimeType: mimeType ?? mediaType,
        url,
        assetId,
        id,
        error,
      }));
    return {
      id: m.id,
      role: m.role,
      sender: m.sender ?? null,
      text,
      attachments,
      inputState: m.inputState ?? null,
      createdAt: m.createdAt,
    };
  });

console.log(JSON.stringify({ chat: process.argv[2], count: messages.length, messages }, null, 2));
