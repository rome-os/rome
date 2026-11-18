import { http, HttpResponse } from "msw";
import type { ChatOutputDto, ChatOutputsResponse } from "@rome/api-types/chat-outputs";
import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";

const HOUR = 3_600_000;

const NOTES = "# Trip plan\n\n- Fly out Friday morning\n- Two nights by the lake\n";

function output(
  chatId: string,
  id: string,
  extra: Partial<ChatOutputDto> & Pick<ChatOutputDto, "name" | "kind">,
): ChatOutputDto {
  return {
    id,
    path: `/projects/default/${extra.name}`,
    link: `/projects/default/${extra.name}`,
    mimeType: null,
    at: new Date(Date.now() - HOUR).toISOString(),
    turnId: null,
    messageId: null,
    missing: false,
    from: null,
    contentUrl: `/api/chat/sessions/${encodeURIComponent(chatId)}/outputs/${id}/content`,
    ...extra,
  };
}

/** The main chat lists a file of its own and one from a task chat; every other chat none. */
function outputsOf(chatId: string): ChatOutputDto[] {
  if (chatId !== CONCIERGE_CHAT_ID) return [];
  return [
    output(chatId, "out-notes", {
      name: "trip-plan.md",
      kind: "written",
      mimeType: "text/markdown",
    }),
    output(chatId, "out-old", {
      name: "draft.txt",
      kind: "written",
      mimeType: "text/plain",
      missing: true,
      contentUrl: null,
      at: new Date(Date.now() - 26 * HOUR).toISOString(),
      from: { chatId: "task-chat-1", name: "Draft the itinerary" },
    }),
  ];
}

export const chatOutputHandlers = [
  http.get("/api/chat/sessions/:id/outputs", ({ params }) =>
    HttpResponse.json({ outputs: outputsOf(String(params.id)) } satisfies ChatOutputsResponse),
  ),
  http.get("/api/chat/sessions/:id/outputs/:outputId/content", ({ params }) =>
    params.outputId === "out-notes"
      ? new HttpResponse(NOTES, { headers: { "Content-Type": "text/markdown" } })
      : HttpResponse.json({ error: "Not found" }, { status: 404 }),
  ),
];
