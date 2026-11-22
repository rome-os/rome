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
  file("projects/default/trip-budget.csv", "Item,Cost\nFlights,420\nHotel,380\nFood,160\n"),
  file(
    "projects/default/fetch-fares.py",
    'fares = {"SFO-HNL": 420, "SFO-OGG": 455}\nprint(min(fares, key=fares.get))\n',
  ),
]);

/** Where the demo's pictures and recording are served, from `mock/public`. */
const DEMO_FILES = "/demo-outputs";

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

/**
 * The main chat lists files of several kinds, of its own and from a task
 * chat, so the tab offers a filter for each kind it holds; every other chat none.
 */
function outputsOf(chatId: string): ChatOutputDto[] {
  if (chatId !== CONCIERGE_CHAT_ID) return [];
  return [
    output(chatId, "out-map", {
      name: "beach-map.png",
      kind: "shown",
      mimeType: "image/png",
      path: "/api/assets/0f3c2a9d7b1e4c6a8d5f2b7e9a1c3d4e.png",
      link: "/api/assets/0f3c2a9d7b1e4c6a8d5f2b7e9a1c3d4e.png",
      contentUrl: `${DEMO_FILES}/beach-map.png`,
      at: new Date(Date.now() - HOUR / 2).toISOString(),
    }),
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
    output(chatId, "out-budget", {
      name: "trip-budget.csv",
      kind: "written",
      mimeType: "text/csv",
      at: new Date(Date.now() - 4 * HOUR).toISOString(),
    }),
    output(chatId, "out-hotels", {
      name: "hotel-photos.jpg",
      kind: "shown",
      mimeType: "image/jpeg",
      path: "/api/assets/6b2d8e4f1a3c5e7b9d0f2a4c6e8b1d3f.jpg",
      link: "/api/assets/6b2d8e4f1a3c5e7b9d0f2a4c6e8b1d3f.jpg",
      contentUrl: `${DEMO_FILES}/hotel-photos.jpg`,
      at: new Date(Date.now() - 5 * HOUR).toISOString(),
    }),
    output(chatId, "out-voice", {
      name: "voice-note.wav",
      kind: "written",
      mimeType: "audio/wav",
      contentUrl: `${DEMO_FILES}/voice-note.wav`,
      at: new Date(Date.now() - 25 * HOUR).toISOString(),
      from: { chatId: "task-chat-1", name: "Draft the itinerary" },
    }),
    output(chatId, "out-script", {
      name: "fetch-fares.py",
      kind: "written",
      mimeType: "text/x-python",
      at: new Date(Date.now() - 25.5 * HOUR).toISOString(),
      from: { chatId: "task-chat-1", name: "Draft the itinerary" },
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
