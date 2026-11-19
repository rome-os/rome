import { http, HttpResponse } from "msw";
import type { ChatOutputDto, ChatOutputsResponse } from "@rome/api-types/chat-outputs";
import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";
import { dir, file } from "./file-browser";

const HOUR = 3_600_000;

const NOTES = "# Trip plan\n\n- Fly out Friday morning\n- Two nights by the lake\n";

/**
 * The files the main chat's agent wrote, as the projects folder holds them:
 * `index.ts` puts this folder in the Projects mock, so an Edit saves to the
 * file the output's preview reads back.
 */
export const outputProjectFolder = dir("projects/default", [
  file("projects/default/trip-plan.md", NOTES),
  file("projects/default/packing-list.txt", "Passport\nCharger\nRain jacket\n"),
  file("projects/default/空白笔记.txt", ""),
]);

function projectBody(name: string): string | undefined {
  return outputProjectFolder.children?.find((node) => node.name === name)?.content;
}

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
    output(chatId, "out-list", {
      name: "packing-list.txt",
      kind: "written",
      mimeType: "text/plain",
      at: new Date(Date.now() - 2 * HOUR).toISOString(),
    }),
    output(chatId, "out-blank", {
      name: "空白笔记.txt",
      kind: "written",
      mimeType: "text/plain",
      at: new Date(Date.now() - 3 * HOUR).toISOString(),
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
  http.get("/api/chat/sessions/:id/outputs/:outputId/content", ({ params }) => {
    const name = outputsOf(CONCIERGE_CHAT_ID).find((entry) => entry.id === params.outputId)?.name;
    const body = name === undefined ? undefined : projectBody(name);
    return body === undefined
      ? HttpResponse.json({ error: "Not found" }, { status: 404 })
      : new HttpResponse(body, {
          headers: {
            "Content-Type": name?.endsWith(".md") ? "text/markdown" : "text/plain",
            "Cache-Control": "no-store",
          },
        });
  }),
];
