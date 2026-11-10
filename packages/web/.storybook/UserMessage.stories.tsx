import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "storybook-react-rsbuild";
import { expect, fn } from "storybook/test";
import { UserMessage } from "../src/components/chat/UserMessage";
import { ReplyDraftProvider } from "../src/components/chat/reply/reply-draft";
import { DASHBOARD_IDENTITY_QUERY_KEY } from "../src/hooks/use-dashboard-identity";
import type { ChatMessage } from "../src/lib/chat-types";
import { formatMessageTimestamp } from "../src/lib/message-timestamp";

const client = new QueryClient();
client.setQueryData(DASHBOARD_IDENTITY_QUERY_KEY, {
  kind: "guardian",
  userId: "storybook-guardian",
  displayName: "Guardian",
  avatarUrl: null,
});
const guardian = { kind: "guardian", name: "Guardian", avatarUrl: null } as const;
const now = new Date();
const older = new Date(now.getFullYear() - 2, 1, 4, 18, 41).toISOString();
const sameYear = new Date(
  now.getFullYear(),
  now.getMonth(),
  now.getDate() === 1 ? 2 : 1,
  18,
  41,
).toISOString();
const sender = {
  kind: "automated",
  sourceType: "agent",
  name: "Al",
  iconUrl: null,
  onBehalfOf: guardian,
} as const;
const message: ChatMessage = {
  id: "storybook-user-message",
  sessionId: "storybook-user-message",
  role: "user",
  content: "ok",
  createdAt: older,
  sender,
};
const chineseMessage = { ...message, sender: { ...sender, name: "日报" } };
const conciergeMessage = {
  ...message,
  createdAt: now.toISOString(),
  sender: { ...sender, name: "Concierge" },
};

const longMessage = {
  ...conciergeMessage,
  content:
    "Please review the proposed schedule and include a summary of the important changes. Keep the explanation clear so I can decide which tasks to prioritize this week.",
};

const meta = {
  title: "Chat/User message",
  component: UserMessage,
  args: { msg: message },
  play: async ({ canvas, args, canvasElement }) => {
    if (canvasElement.clientWidth < 375) return;
    await document.fonts.ready;
    const timestamp = canvas.getByText(formatMessageTimestamp(args.msg.createdAt));
    await expect(timestamp.scrollWidth).toBeLessThanOrEqual(timestamp.clientWidth);
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <ReplyDraftProvider
          value={{
            sessionId: message.sessionId,
            target: null,
            set: fn(),
            clear: fn(),
            restore: fn(),
            has: () => true,
            jump: fn(),
            threads: false,
            thread: null,
            openThread: fn(),
            closeThread: fn(),
          }}
        >
          <div className="min-h-screen bg-chat-canvas p-4">
            <div className="mx-auto max-w-3xl">
              <Story />
            </div>
          </div>
        </ReplyDraftProvider>
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof UserMessage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ShortBadgeOlderTimestamp: Story = {};
export const ShortBadgeSameYearTimestamp: Story = {
  args: { msg: { ...message, createdAt: sameYear } },
};
export const ChineseShortBadgeOlderTimestamp: Story = {
  globals: { locale: "zh-CN" },
  args: { msg: chineseMessage },
};
export const ChineseShortBadgeSameYearTimestamp: Story = {
  globals: { locale: "zh-CN" },
  args: { msg: { ...chineseMessage, createdAt: sameYear } },
};
export const LongName: Story = {
  args: {
    msg: {
      ...conciergeMessage,
      sender: {
        ...sender,
        name: "A very long automation name that must truncate instead of overflowing the footer row",
      },
    },
  },
};
export const ShortMessage: Story = { args: { msg: conciergeMessage } };
export const LongMessage: Story = { args: { msg: longMessage } };
export const NoBadge: Story = { args: { msg: { ...longMessage, sender: guardian } } };
export const ShortNoBadge: Story = { args: { msg: { ...conciergeMessage, sender: guardian } } };
export const OldTimestamp: Story = { args: { msg: { ...conciergeMessage, createdAt: older } } };
