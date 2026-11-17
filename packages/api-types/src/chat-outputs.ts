// Wire types of a chat's outputs: the files its agent wrote or showed. The
// server is packages/core/src/chats/outputs and the clients are packages/web
// and the iOS app. Fields are only ever added. docs/domains/chats.md#outputs

/** How the agent produced a file: wrote it with a tool, or showed it in the chat. */
export const CHAT_OUTPUT_KINDS = ["written", "shown"] as const;
export type ChatOutputKind = (typeof CHAT_OUTPUT_KINDS)[number];

/** The task chat an output of a Concierge chat came from. */
export interface ChatOutputSource {
  chatId: string;
  name: string;
}

/** One file, at the latest time the agent wrote or showed it. */
export interface ChatOutputDto {
  /** Stable while the file's latest record stays the latest. Names it in the content route. */
  id: string;
  kind: ChatOutputKind;
  /** The file's name, for display. */
  name: string;
  /** The path written, as the tool named it, or a shown copy's asset URL. */
  path: string;
  /**
   * The link a chat message gives the same file, so a client can tell a
   * message's link is this output: `/projects/<project>/<path>` for a file in
   * the projects folder, `/api/assets/<name>` for a shown copy, else null.
   */
  link: string | null;
  /** Null when the extension says nothing. */
  mimeType: string | null;
  /** When it was written or shown, ISO 8601. */
  at: string;
  turnId: string | null;
  messageId: string | null;
  /** The written file is gone from where it was written, or the shown copy is. */
  missing: boolean;
  /** Set on a Concierge chat's list for an output of one of its task chats. */
  from: ChatOutputSource | null;
  /** `GET` it for the file's bytes. Null while the file cannot be served. */
  contentUrl: string | null;
}

/** `GET /api/chat/sessions/:id/outputs`, newest first. */
export interface ChatOutputsResponse {
  outputs: ChatOutputDto[];
  /**
   * Outputs from before Rome recorded them are still being read back, so the
   * list may grow. Absent from servers that read back while listing.
   */
  indexing?: boolean;
}
