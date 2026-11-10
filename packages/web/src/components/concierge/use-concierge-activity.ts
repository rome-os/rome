import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import type { ConciergeActivity } from "@rome/api-types/concierge-activity";
import { CONCIERGE_ACTIVITY_TOPIC } from "@rome/api-types/live-events";
import { CONCIERGE_CHATS_QUERY_KEY, useConciergeChats } from "@/hooks/use-concierge";
import { type LiveTopic, useLiveEvents } from "@/hooks/use-live-events";

const conciergeActivityTopic: LiveTopic = {
  topic: CONCIERGE_ACTIVITY_TOPIC,
  sseUrl: "/api/concierge/activity/events",
};

const TOOLS = [
  "startingTask",
  "messagingTask",
  "readingChat",
  "stoppingTask",
  "updatingTasks",
  "startingTopic",
  "checkingFollows",
  "searchingWeb",
  "readingPage",
] as const;

// A kind or a tool from a newer server fails the parse, and the event is dropped.
const activitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("needsYou") }),
  z.object({ kind: z.literal("working") }),
  z.object({ kind: z.literal("tool"), tool: z.enum(TOOLS) }),
  z.object({ kind: z.literal("tasks"), title: z.string(), more: z.number() }),
]) satisfies z.ZodType<ConciergeActivity>;

const activityEventSchema = z.object({
  chatId: z.string(),
  activity: activitySchema,
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
        fn: ({ chatId: id, activity }) =>
          setLive((prev) => {
            const next = new Map(prev);
            next.set(id, activity);
            return next;
          }),
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
  return live.get(chatId) ?? chats.find((chat) => chat.id === chatId)?.activity ?? IDLE;
}
