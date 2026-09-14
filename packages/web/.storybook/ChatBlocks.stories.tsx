import type { Meta, StoryObj } from "storybook-react-rsbuild";
import { ChatBlockPreview, CHAT_BLOCK_SPECIMENS } from "../src/pages/dev/ChatBlocksPage";

const meta = {
  title: "Dev/Chat blocks",
  component: ChatBlockPreview,
  parameters: { layout: "padded" },
  args: {
    sessionId: "storybook-chat-blocks",
    onSubmitAppComponent: () => undefined,
    onDismissAppComponent: () => undefined,
  },
} satisfies Meta<typeof ChatBlockPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompactQuestion: Story = {
  args: { block: CHAT_BLOCK_SPECIMENS[0].block },
};

export const StackedQuestion: Story = {
  args: { block: CHAT_BLOCK_SPECIMENS[1].block },
};

export const ResolvedQuestion: Story = {
  args: {
    block: CHAT_BLOCK_SPECIMENS[4].block,
    result: CHAT_BLOCK_SPECIMENS[4].result,
  },
};
