import type { Page } from "@playwright/test";
import type { ChatMessage, TranscriptPart } from "../src/lib/chat-types";

export type WaitingCardKind = "routine" | "plan" | "question" | "ai" | "app";

export async function openWaitingCard(
  page: Page,
  kind: WaitingCardKind,
  followUp?: "text" | "proposal",
) {
  let card: TranscriptPart =
    kind === "routine"
      ? {
          type: "routine_draft_card",
          toolUseId: "waiting-card",
          routineKey: "chat-routine:waiting-card",
          draft: {
            name: "Weekly update",
            sentence: "Every Monday at 9:00 AM, remind me to send the weekly update.",
            watchLabel: "Mondays at 9:00 AM",
            thenSummary: "Send a reminder",
            trigger: {
              type: "schedule",
              tzid: "Etc/UTC",
              tzMode: "floating",
              localTime: "09:00",
              rrule: "FREQ=WEEKLY;BYDAY=MO",
            },
            actionName: "summon",
            args: { agentName: "main", prompt: "Remind me to send the weekly update." },
          },
        }
      : kind === "plan"
        ? {
            type: "approval_card",
            approvalId: "waiting-plan",
            actionName: "weekly_update",
            status: "pending",
            preview: {
              kind: "generic",
              title: "Weekly update plan",
              summary: "Collect this week's notes, draft the update, and send it after approval.",
            },
          }
        : {
            type: "pending_interaction",
            toolUseId: "waiting-card",
            appId: "core",
            render: {
              kind: "inline",
              builtin: true,
              componentId: "question-card",
              props: {
                questions: [
                  {
                    id: "day",
                    question: "Which day should the update arrive?",
                    type: "single",
                    options: ["Monday", "Friday"],
                  },
                ],
              },
            },
          };
  if (kind === "ai" || kind === "app")
    card = {
      type: "pending_interaction",
      toolUseId: "waiting-card",
      appId: kind === "ai" ? "core" : "waiting-app",
      render: {
        kind: "inline",
        componentId: kind === "ai" ? "ai-tools-card" : "form",
        ...(kind === "ai" ? { builtin: true } : {}),
        props: { title: "Original app form" },
      },
    };
  const sessionId = "mock-chat-3";
  const messages: ChatMessage[] = [
    {
      id: "waiting-request",
      sessionId,
      role: "user",
      turnId: "waiting-turn",
      createdAt: "2026-09-15T09:00:00Z",
      content: JSON.stringify([{ type: "text", content: "Help me prepare the weekly update." }]),
    },
    {
      id: "waiting-reply",
      sessionId,
      role: "assistant",
      turnId: "waiting-turn",
      createdAt: "2026-09-15T09:00:01Z",
      content: JSON.stringify([
        card,
        {
          type: "text",
          content: Array.from(
            { length: 14 },
            (_, i) =>
              `### ${i + 1}. Preparing the update\n\nCollect the team's progress, note anything that needs a decision, and include the next steps. Review the card above before proceeding.`,
          ).join("\n\n"),
        },
      ]),
    },
  ];
  if (followUp) {
    const original = JSON.parse(messages[1].content) as TranscriptPart[];
    const replacement = structuredClone(card);
    if (replacement.type === "routine_draft_card") {
      replacement.toolUseId = "replacement-card";
      replacement.routineKey = "chat-routine:replacement-card";
      replacement.draft.name = "Replacement routine";
      replacement.draft.sentence = "Replacement routine proposal";
    } else if (replacement.type === "pending_interaction") {
      replacement.toolUseId = "replacement-card";
      replacement.render.props = { title: "Replacement app form" };
    }
    messages.push(
      {
        id: "follow-up",
        sessionId,
        role: "user",
        turnId: "next-turn",
        createdAt: "2026-09-15T09:01:00Z",
        content: JSON.stringify([
          { type: "text", content: "Ignore that proposal and try another approach." },
        ]),
      },
      {
        id: "replacement-reply",
        sessionId,
        role: "assistant",
        turnId: "next-turn",
        createdAt: "2026-09-15T09:01:01Z",
        content: JSON.stringify([
          ...(followUp === "proposal" ? [replacement] : []),
          ...original.filter((b) => b.type === "text"),
        ]),
      },
    );
  }
  // Intercept before MSW so these scenarios control the card's server state.
  // Every write stays local, including the interaction result that resumes a turn.
  await page.addInitScript(
    ({ messages, sessionId }) => {
      localStorage.setItem("i18nextLng", "en");
      let routine: Record<string, unknown> | null = null;
      let approvalStatus = "pending";
      const fetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
        const path = url.pathname;
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        if (path === `/api/chat/sessions/${sessionId}/messages`)
          return Response.json(
            url.searchParams.has("limit") ? { messages, nextCursor: null } : messages,
          );
        if (path === "/api/ai-tools/status")
          return Response.json({ claude: { loggedIn: false }, codex: { loggedIn: false } });
        if (path === "/api/ai-tools/rome-credits") return Response.json({ credits: null });
        if (path === "/api/ai-tools/anthropic-compatible-providers")
          return Response.json({ providers: [], configured: null });
        if (path.startsWith("/api/apps/waiting-app/manifest"))
          return Response.json({
            appId: "waiting-app",
            appName: "Waiting app",
            styleUrls: [],
            bootstrap: { shell: {} },
            entryUrl:
              "data:text/javascript," +
              encodeURIComponent(
                'export function mountComponent(container, id, ctx) { const label = document.createElement("p"); label.textContent = ctx.props.title; const button = document.createElement("button"); button.textContent = "Submit form"; button.disabled = ctx.host.resolved; button.onclick = () => ctx.host.submit({ approved: true }); container.append(label, button); }',
              ),
          });
        if (path === "/api/routines" && method === "GET")
          return Response.json(routine ? [routine] : []);
        if (path === "/api/routines" && method === "POST") {
          routine = { ...JSON.parse(String(init?.body)), id: "waiting-routine" };
          return Response.json(routine, { status: 201 });
        }
        if (path.startsWith("/api/approvals/waiting-plan")) {
          if (path.endsWith("/approve")) approvalStatus = "approved";
          if (path.endsWith("/reject")) approvalStatus = "rejected";
          return Response.json({
            id: "waiting-plan",
            status: approvalStatus,
            executionState: "idle",
            executionError: null,
            success: true,
          });
        }
        if (path === `/api/chat/sessions/${sessionId}/turns` && method === "POST") {
          const body = JSON.parse(String(init?.body));
          messages.push({
            id: body.inputId,
            sessionId,
            role: "user",
            content: JSON.stringify(body.parts),
            createdAt: new Date().toISOString(),
          });
          return Response.json({
            turnId: null,
            inputId: body.inputId,
            sessionId,
            startedAt: new Date().toISOString(),
          });
        }
        if (path.startsWith("/api/") && !["GET", "HEAD"].includes(method))
          return Response.json({ success: true });
        return fetch(input, init);
      };
    },
    { messages, sessionId },
  );
  await page.goto(`/chat/${sessionId}`, { waitUntil: "commit" });
}
