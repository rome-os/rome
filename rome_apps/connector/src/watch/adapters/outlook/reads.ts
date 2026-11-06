// What the Outlook normalizer reads: a message by its id, from Microsoft
// Graph through the connected account. Tests inject their own.

import type { ComposioToolkit, Json, WatchEnv } from "../../types.js";

export interface OutlookReads {
  /** A Microsoft Graph message, with its headers. */
  outlookMessage(id: string): Promise<Json>;
}

export const outlookReads = (env: WatchEnv, service: ComposioToolkit): OutlookReads => ({
  outlookMessage: (id) =>
    env.composio.read(service, {
      endpoint: `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}`,
      query: {
        $select:
          "id,subject,bodyPreview,from,sender,toRecipients,ccRecipients,webLink,conversationId,inferenceClassification,importance,internetMessageHeaders",
      },
    }),
});
