import type { Meta, StoryObj } from "storybook-react-rsbuild";
import { PairingRequestCard } from "../src/components/pairing/pairing-views";
import { pairingStory } from "./pairing-fixtures";

const meta = {
  title: "Connections/Pairing/Request",
  component: PairingRequestCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-lg">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    channel: {
      control: "select",
      options: [0, 1, 2].map((index) => pairingStory(index).channel),
    },
  },
  args: pairingStory(),
} satisfies Meta<typeof PairingRequestCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Approved: Story = {
  args: { resolvedBy: "guardian", resolvedAt: "2026-09-10T10:04:00.000Z" },
};
export const LongIdentity: Story = {
  args: {
    name: "Alexandra — Personal account with a long display name",
    accountId: "ou_0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz",
  },
};
export const Rejected: Story = {
  args: { status: "rejected", resolvedBy: "guardian", resolvedAt: "2026-09-10T10:04:00.000Z" },
};
export const Expired: Story = { args: { status: "expired", resolvedBy: null } };
