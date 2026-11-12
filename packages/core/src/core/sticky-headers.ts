// The header blocks an input opens with that a thread reads again only when
// they change: the Concierge chat a turn runs in and the person it serves
// (concierge/service.ts `turnHeader`), and the dashboard's open workspace
// (agent/domain/prompt.ts `buildWorkspaceContextSection`).
export const STICKY_HEADERS: readonly string[] = [
  "concierge_chat",
  "concierge_owner",
  "workspace_context",
];
