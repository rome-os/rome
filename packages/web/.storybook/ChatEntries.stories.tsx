import type { Meta, StoryObj } from "storybook-react-rsbuild";
import { expect, fn, userEvent } from "storybook/test";
import { ChatEntryPreview, CHAT_ENTRY_SPECIMENS } from "../src/pages/dev/ChatEntriesPage";

const meta = {
  title: "Dev/Chat entries",
  component: ChatEntryPreview,
  parameters: { layout: "padded" },
  args: {
    sessionId: "storybook-chat-entries",
    onSubmitAppComponent: () => undefined,
    onDismissAppComponent: () => undefined,
  },
} satisfies Meta<typeof ChatEntryPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

function specimen(id: string) {
  const found = CHAT_ENTRY_SPECIMENS.find((item) => item.id === id);
  if (!found) throw new Error(`Missing chat block specimen: ${id}`);
  return found;
}

export const CompactQuestion: Story = {
  args: { block: specimen("question-card-compact").block },
};

export const StackedQuestion: Story = {
  args: { block: specimen("question-card-stacked").block },
};

export const ResolvedQuestion: Story = {
  args: {
    block: specimen("question-card-resolved").block,
    result: specimen("question-card-resolved").result,
  },
};

export const WideCompactQuestion: Story = {
  args: { block: specimen("question-card-cjk").block },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
};

export const NarrowQuestion: Story = {
  ...WideCompactQuestion,
  decorators: [
    (Story) => (
      <div className="w-64 max-w-full">
        <Story />
      </div>
    ),
  ],
};

export const UnbrokenLabels: Story = {
  args: { block: specimen("question-card-unbroken").block },
  decorators: NarrowQuestion.decorators,
};

export const WrappedSubmission: Story = {
  ...NarrowQuestion,
  args: { ...NarrowQuestion.args, onSubmitAppComponent: fn() },
  play: async ({ canvas, args }) => {
    const answer = "要，中文 + 英文，默认跟随 Rome 界面语言";
    const option = canvas.getByRole("button", { name: answer });
    option.focus();
    await userEvent.keyboard(" ");
    await expect(option).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(canvas.getByRole("button", { name: /^(Send|发送)$/ }));
    await expect(args.onSubmitAppComponent).toHaveBeenCalledWith(
      "storybook-chat-entries",
      "dev-ask-cjk",
      { answers: [{ questionId: "i18n", value: answer }] },
      answer,
    );
    await expect(option).toBeDisabled();
  },
};
