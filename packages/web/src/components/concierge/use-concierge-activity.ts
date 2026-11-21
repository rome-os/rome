import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { type ConciergeActivity, parseConciergeActivity } from "@rome/api-types/concierge-activity";
import { CONCIERGE_ACTIVITY_TOPIC } from "@rome/api-types/live-events";
import { CONCIERGE_CHATS_QUERY_KEY, useConciergeChats } from "@/hooks/use-concierge";
import { type LiveTopic, useLiveEvents } from "@/hooks/use-live-events";

const conciergeActivityTopic: LiveTopic = {
  topic: CONCIERGE_ACTIVITY_TOPIC,
  sseUrl: "/api/concierge/activity/events",
};

// Only the envelope is checked here; the activity itself is read by
// `parseConciergeActivity`, so a tool or kind from a newer server degrades
// rather than dropping the event.
const activityEventSchema = z.object({
  chatId: z.string(),
  activity: z.unknown(),
  at: z.number(),
});

const IDLE: ConciergeActivity = { kind: "idle" };

/**
 * What Concierge chat `chatId` is doing, as core tells it: the chats list's
 * `activity` at first, then each `concierge_activity` event on the owner's
 * `concierge.activity` topic, which also replays every chat on (re)subscribe.
 * Idle for no chat, and before either has said anything.
 */
export function useConciergeActivity(chatId: string | null): ConciergeActivity {
  const queryClient = useQueryClient();
  const chats = useConciergeChats();
  const [live, setLive] = useState<ReadonlyMap<string, ConciergeActivity>>(new Map());

  useLiveEvents(
    conciergeActivityTopic,
    {
      concierge_activity: {
        schema: activityEventSchema,
        fn: ({ chatId: id, activity: raw }) => {
          // A kind this client does not know reads as idle, over whatever
          // the chat showed before, live or from the list.
          const activity = parseConciergeActivity(raw) ?? IDLE;
          setLive((prev) => {
            const next = new Map(prev);
            next.set(id, activity);
            return next;
          });
        },
      },
    },
    {
      enabled: chatId !== null,
      // The new subscription replays every chat; until then the list's
      // field is the freshest word.
      onReconnect: () => {
        setLive(new Map());
        void queryClient.invalidateQueries({ queryKey: CONCIERGE_CHATS_QUERY_KEY });
      },
    },
  );

  if (!chatId) return IDLE;
  const listed = parseConciergeActivity(chats.find((chat) => chat.id === chatId)?.activity);
  return live.get(chatId) ?? listed ?? IDLE;
}
